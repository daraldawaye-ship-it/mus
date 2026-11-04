import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { MarketAccess } from "./routes-medicine-market.ts";
import { handler, parse } from "./http.ts";
import { deny, HttpError, missing } from "./errors.ts";

export function stagingUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash && /^sdmntpr[a-z0-9]+\.oaiusercontent\.com$/.test(u.hostname) && /^\/files\/[a-zA-Z0-9-]+\/raw$/.test(u.pathname); } catch { return false; }
}
export const stagingImportSchema = z.object({
  idempotencyKey: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.string().max(5000).refine(stagingUrl),
}).strict();
export const mcpBodySchemas = { stagingImportSchema };
const sourceSchema = z.object({type:z.literal("source"),key:z.string().min(1).max(150),filename:z.string().max(500),driveId:z.string().min(1).max(200),modifiedAt:z.string().max(100),sha256:z.string().regex(/^[a-f0-9]{64}$/),byteSize:z.number().int().min(0).max(100000000),rowCount:z.number().int().min(0).max(500000),metadata:z.record(z.string(),z.unknown())}).strict();
const rowSchema = z.object({type:z.literal("row"),section:z.string().max(500),position:z.number().int().positive(),payload:z.string().max(4000000)}).strict();
const chunkSchema = z.object({type:z.literal("chunk"),index:z.number().int().min(0),data:z.string().max(400000).regex(/^[A-Za-z0-9+/]*={0,2}$/)}).strict();
const endSchema = z.object({type:z.literal("end")}).strict();
const lineSchema = z.discriminatedUnion("type",[sourceSchema,rowSchema,chunkSchema,endSchema]);

// One SQL transaction: malformed/partial input never leaves a partially accepted source.
export async function loadStagingLines(db: PoolClient, jobId: string, lines: AsyncIterable<string>) {
  let current: {id:string; expected:z.infer<typeof sourceSchema>; hash:ReturnType<typeof createHash>; bytes:number; chunks:number; rows:number} | undefined;
  let pending: z.infer<typeof rowSchema>[] = [], count = 0, pendingBytes = 0;
  async function flush() {
    if (!pending.length || !current) return;
    await db.query("INSERT INTO market_import_rows(source_id,section,position,payload_text,payload) SELECT $1,r.section,r.position,r.payload,r.payload::jsonb FROM jsonb_to_recordset($2::jsonb) AS r(section text,position integer,payload text)",[current.id,JSON.stringify(pending)]);
    pending=[];pendingBytes=0;
  }
  for await (const line of lines) {
    if (line.length > 5000000 || !line) throw new Error("invalid_line");
    const v = lineSchema.parse(JSON.parse(line));
    if (v.type === "source") {
      if (current || ++count > 100) throw new Error("source_order");
      const r=await db.query("INSERT INTO market_import_sources(job_id,source_key,filename,drive_id,modified_at,sha256,byte_size,row_count,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",[jobId,v.key,v.filename,v.driveId,v.modifiedAt,v.sha256,v.byteSize,v.rowCount,JSON.stringify(v.metadata)]);
      current={id:String(r.rows[0].id),expected:v,hash:createHash("sha256"),bytes:0,chunks:0,rows:0};
    } else if (!current) throw new Error("missing_source");
    else if (v.type === "chunk") {
      if (v.index!==current.chunks++ || current.rows) throw new Error("chunk_order");
      const bytes=Buffer.from(v.data,"base64");
      if(bytes.toString("base64")!==v.data)throw new Error("base64");
      current.bytes+=bytes.length;if(current.bytes>current.expected.byteSize)throw new Error("source_size");current.hash.update(bytes);
      await db.query("INSERT INTO market_import_chunks(source_id,chunk_index,data) VALUES($1,$2,$3)",[current.id,v.index,bytes]);
    } else if (v.type === "row") {
      if(++current.rows>current.expected.rowCount)throw new Error("row_count");
      pending.push(v);pendingBytes+=Buffer.byteLength(v.payload);
      if(pending.length>=250 || pendingBytes>=1000000)await flush();
    } else {
      await flush();
      if(current.rows!==current.expected.rowCount || current.bytes!==current.expected.byteSize || current.hash.digest("hex")!==current.expected.sha256)throw new Error("source_integrity");
      current=undefined;
    }
  }
  if(current || !count)throw new Error("incomplete_bundle");
}

async function receiveBundle(db:PoolClient, input:z.infer<typeof stagingImportSchema>) {
  const dir=await mkdtemp(join(tmpdir(),"market-staging-")), path=join(dir,"bundle.ndjson");
  let inTransaction=false;
  try {
    const response=await fetch(input.url,{redirect:"error",signal:AbortSignal.timeout(180000)});
    if(!response.ok || !response.body)throw new Error("download_failed");
    const hash=createHash("sha256");let bytes=0,compressed=0;
    const boundCompressed=new Transform({transform(chunk,_encoding,callback){compressed+=chunk.length;callback(compressed>100000000?new Error("compressed_limit"):null,chunk);}});
    const bound=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(bytes>300000000?new Error("expanded_limit"):null,chunk);}});
    await pipeline(Readable.fromWeb(response.body as never),boundCompressed,createGunzip(),bound,createWriteStream(path));
    if(hash.digest("hex")!==input.sha256)throw new Error("bundle_hash");
    await db.query("BEGIN");inTransaction=true;
    await db.query("SET LOCAL statement_timeout='30s'");
    await loadStagingLines(db,input.idempotencyKey,createInterface({input:createReadStream(path),crlfDelay:Infinity}));
    await db.query("UPDATE market_import_jobs SET status='complete',error_code=NULL,updated_at=now() WHERE id=$1",[input.idempotencyKey]);
    await db.query("COMMIT");inTransaction=false;
  } catch {
    if(inTransaction)await db.query("ROLLBACK");
    await db.query("UPDATE market_import_jobs SET status='failed',error_code='import_failed',updated_at=now() WHERE id=$1",[input.idempotencyKey]);
  } finally { await rm(dir,{recursive:true,force:true}); }
}

export function marketStagingRoutes(pool:Pool, access:MarketAccess, isolated:boolean) {
  const router=Router();
  const authorize=async(req:Parameters<MarketAccess["viewer"]>[1])=>{
    const u=await access.viewer(pool,req);if(!u?.owner || u.suspended || u.archived)deny();
    await access.enabled(pool,req);
    if(!isolated)throw new HttpError(503,"market_isolation_required","الاستقبال متاح في قاعدة السوق المنفصلة فقط");
    return u;
  };
  router.post("/medicine-market/staging/import",handler(async(req,res)=>{
    const user=await authorize(req),input=parse(stagingImportSchema,req.body);
    const db=await pool.connect();let handed=false,locked=false;
    try {
      locked=(await db.query("SELECT pg_try_advisory_lock(714390215) AS ok")).rows[0].ok;
      if(!locked)throw new HttpError(409,"staging_busy","يوجد استيراد قيد التنفيذ");
      const old=(await db.query("SELECT id,bundle_sha256,status FROM market_import_jobs WHERE id=$1 OR bundle_sha256=$2",[input.idempotencyKey,input.sha256])).rows;
      if(old.length && (old.length!==1 || old[0].id!==input.idempotencyKey || old[0].bundle_sha256!==input.sha256))throw new HttpError(409,"staging_duplicate","حزمة أو مفتاح استيراد مكرر");
      if(old[0]?.status==="complete"){res.json({id:input.idempotencyKey,status:"complete"});return;}
      await db.query("INSERT INTO market_import_jobs(id,bundle_sha256,actor_id,status) VALUES($1,$2,$3,'running') ON CONFLICT(id) DO UPDATE SET status='running',error_code=NULL,updated_at=now()",[input.idempotencyKey,input.sha256,user.id]);
      handed=true;
      void receiveBundle(db,input).catch(()=>console.error("MARKET_STAGING_IMPORT_FAILED")).finally(async()=>{try{await db.query("SELECT pg_advisory_unlock(714390215)");}finally{db.release();}});
      res.status(202).json({id:input.idempotencyKey,status:"running"});
    } finally {if(!handed){try{if(locked)await db.query("SELECT pg_advisory_unlock(714390215)");}finally{db.release();}}}
  }));
  router.get("/medicine-market/staging",handler(async(req,res)=>{
    await authorize(req);
    const jobs=await pool.query("SELECT id,bundle_sha256,status,error_code,created_at,updated_at FROM market_import_jobs ORDER BY created_at DESC LIMIT 100");
    const sources=await pool.query("SELECT s.*, (SELECT count(*)::int FROM market_import_rows r WHERE r.source_id=s.id) AS actual_rows,(SELECT coalesce(sum(octet_length(c.data)),0)::text FROM market_import_chunks c WHERE c.source_id=s.id) AS actual_bytes FROM market_import_sources s ORDER BY id LIMIT 1000");
    res.json({jobs:jobs.rows,sources:sources.rows});
  }));
  router.get("/medicine-market/staging/:sourceId/rows",handler(async(req,res)=>{
    await authorize(req);
    const sourceId=parse(z.coerce.number().int().positive(),req.params.sourceId);
    const q=parse(z.object({after:z.coerce.number().int().min(0).default(0),section:z.string().max(500),pageSize:z.coerce.number().int().min(1).max(20).default(10)}).strict(),req.query);
    if(!(await pool.query("SELECT 1 FROM market_import_sources WHERE id=$1",[sourceId])).rowCount)missing();
    const rows=await pool.query("SELECT section,position,payload_text FROM market_import_rows WHERE source_id=$1 AND section=$2 AND position>$3 ORDER BY position LIMIT $4",[sourceId,q.section,q.after,q.pageSize]);
    res.json({items:rows.rows});
  }));
  return router;
}
