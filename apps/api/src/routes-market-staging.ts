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
import { arabizeMarketName, normalizedArabicSearch } from "./market-arabic-names.ts";
import { handler, parse } from "./http.ts";
import { deny, HttpError, missing } from "./errors.ts";

export function stagingUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash && /^sdmntpr[a-z0-9]+\.oaiusercontent\.com$/.test(u.hostname) && /^\/files\/[a-zA-Z0-9-]+\/raw$/.test(u.pathname); } catch { return false; }
}
export const stagingImportSchema = z.object({
  idempotencyKey: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.string().max(5000).refine(stagingUrl),
}).strict();
const bulkMedicinePromotionSchema = z.object({ idempotencyKey: z.string().uuid() }).strict();
export const mcpBodySchemas = { stagingImportSchema, bulkMedicinePromotionSchema };
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


const stagedMedicineName = (name: string) => name.normalize("NFKC").replace(/\s+/g, " ").trim();
const stagedMedicineKey = (name: string) => name.normalize("NFKC")
  .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
  .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي")
  .replace(/\s+/g, " ").trim().toLowerCase();

/** The whole promotion commits once; failures roll back all cards and the archival. */
async function promoteStagedMedicines(pool: Pool, sourceId: number, runId: string, actorId: number, actorName: string) {
  const db = await pool.connect();
  let inTransaction = false;
  try {
    await db.query("BEGIN"); inTransaction = true;
    await db.query("SET LOCAL statement_timeout='180s'");
    await db.query("SELECT pg_advisory_xact_lock(714390218)");
    const result = await db.query<{position: number; name: string | null}>(
      "SELECT position,(SELECT c->>'value' FROM jsonb_array_elements(payload->'cells') AS c WHERE c->>'column'='1' LIMIT 1) AS name FROM market_import_rows WHERE source_id=$1 AND section='ورقة1' ORDER BY position",
      [sourceId],
    );
    const unique = new Map<string, {name:string; normalized:string; position:number; idempotency_key:string}>();
    let skipped = 0, repeatedSource = 0, arabicNames = 0;
    for (const row of result.rows) {
      const name = typeof row.name === "string" ? stagedMedicineName(row.name) : "";
      const normalized = stagedMedicineKey(name);
      if (row.position === 1 || !name || name.length > 300 || name.includes("\u0000") || !normalized || normalized.length > 300) { skipped++; continue; }
      if (unique.has(normalized)) { repeatedSource++; continue; }
      if (/[\u0600-\u06FF]/.test(name)) arabicNames++;
      unique.set(normalized, {name, normalized, position:row.position, idempotency_key:randomUUID()});
    }
    let inserted = 0;
    const prepared = [...unique.values()];
    for (let start = 0; start < prepared.length; start += 2500) {
      const chunk = prepared.slice(start, start + 2500);
      const added = await db.query(
        "INSERT INTO medicine_market_cards(kind,name,normalized_name,data,status,created_by,idempotency_key) " +
        "SELECT 'medicine',x.name,x.normalized,jsonb_build_object('englishName',x.name,'importSourceId',$3::bigint,'importSourcePosition',x.position)," +
        "'published',$2::integer,x.idempotency_key::uuid " +
        "FROM jsonb_to_recordset($1::jsonb) AS x(name text,normalized text,position integer,idempotency_key text) " +
        "ON CONFLICT DO NOTHING RETURNING id",
        [JSON.stringify(chunk),actorId,sourceId],
      );
      inserted += added.rowCount ?? 0;
    }
    const archived = await db.query(
      "UPDATE medicine_market_cards SET archived=true,revision=revision+1,updated_at=now() WHERE id=815 AND kind='medicine' AND NOT archived RETURNING id",
    );
    const duplicates = repeatedSource + prepared.length - inserted;
    await db.query(
      "UPDATE market_card_import_runs SET status='complete',source_rows=$2,inserted=$3,duplicates=$4,skipped=$5,arabic_names=$6,archived_existing=$7,error_code=NULL,updated_at=now() WHERE id=$1",
      [runId,result.rows.length,inserted,duplicates,skipped,arabicNames,archived.rowCount ?? 0],
    );
    await db.query(
      "INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value) " +
      "VALUES($1,$2,'public',NULL,'medicine-market.bulk_import_ibn_hayyan','medicine-market',NULL,NULL,$3::jsonb)",
      [actorId,actorName,JSON.stringify({sourceId,runId,sourceRows:result.rows.length,inserted,duplicates,skipped,arabicNames,archivedExisting:archived.rowCount ?? 0})],
    );
    await db.query("COMMIT"); inTransaction = false;
  } catch (error) {
    if (inTransaction) { try { await db.query("ROLLBACK"); } catch { /* connection may be gone */ } }
    try { await pool.query("UPDATE market_card_import_runs SET status='failed',error_code='promotion_failed',updated_at=now() WHERE id=$1 AND status='running'",[runId]); } catch { /* logged below */ }
    console.error("MARKET_STAGING_PROMOTION_FAILED", error && typeof error === "object" && "code" in error ? String(error.code) : "internal");
  } finally { db.release(); }
}


/** One database-side update formats all imported medicine names without per-card requests. */
async function titleCaseImportedMarketNames(pool: Pool, sourceId: number, runId: string, actorId: number, actorName: string) {
  const db = await pool.connect();
  let inTransaction = false;
  try {
    await db.query("BEGIN"); inTransaction = true;
    await db.query("SET LOCAL statement_timeout='120s'");
    await db.query("SELECT pg_advisory_xact_lock(714390219)");
    const totalResult = await db.query<{total: number}>(
      "SELECT count(*)::integer AS total FROM medicine_market_cards WHERE kind='medicine' AND status='published' AND NOT archived AND data->>'importSourceId'=$1",
      [String(sourceId)],
    );
    const total = totalResult.rows[0]?.total ?? 0;
    const changed = await db.query(
      "WITH renamed AS (" +
      " SELECT id,initcap(lower(name)) AS titled_name," +
      " initcap(lower(COALESCE(data->>'englishName',name))) AS titled_english" +
      " FROM medicine_market_cards WHERE kind='medicine' AND status='published' AND NOT archived AND data->>'importSourceId'=$1" +
      ") UPDATE medicine_market_cards c SET name=r.titled_name," +
      " data=jsonb_set(c.data,'{englishName}',to_jsonb(r.titled_english),true)," +
      " revision=c.revision+1,updated_at=now() FROM renamed r WHERE c.id=r.id" +
      " AND (c.name IS DISTINCT FROM r.titled_name OR c.data->>'englishName' IS DISTINCT FROM r.titled_english)",
      [String(sourceId)],
    );
    await db.query(
      "UPDATE market_card_name_format_runs SET status='complete',total=$2,changed=$3,error_code=NULL,updated_at=now() WHERE id=$1",
      [runId,total,changed.rowCount ?? 0],
    );
    await db.query(
      "INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)" +
      " VALUES($1,$2,'public',NULL,'medicine-market.bulk_title_case','medicine-market',NULL,NULL,$3::jsonb)",
      [actorId,actorName,JSON.stringify({runId,sourceId,total,changed:changed.rowCount ?? 0})],
    );
    await db.query("COMMIT"); inTransaction = false;
  } catch(error) {
    if(inTransaction) { try { await db.query("ROLLBACK"); } catch { /* disconnected */ } }
    try { await pool.query("UPDATE market_card_name_format_runs SET status='failed',error_code='format_failed',updated_at=now() WHERE id=$1 AND status='running'",[runId]); } catch { /* check server logs */ }
    console.error("MARKET_BULK_TITLE_CASE_FAILED",error && typeof error==="object" && "code" in error ? String(error.code) : "internal");
  } finally { db.release(); }
}


/** The entire Ibn Hayyan name conversion is committed or rolled back together. */
async function arabizeImportedMarketNames(pool:Pool, sourceId:number, runId:string, actorId:number, actorName:string){
  const db=await pool.connect();
  let inTransaction=false;
  try {
    await db.query("BEGIN");inTransaction=true;
    await db.query("SET LOCAL statement_timeout='240s'");
    await db.query("SELECT pg_advisory_xact_lock(714390220)");
    const cards=await db.query<{id:number;name:string;revision:number;data:Record<string,unknown>}>(
      "SELECT id,name,revision,data FROM medicine_market_cards"+
      " WHERE kind='medicine' AND status='published' AND NOT archived AND data->>'importSourceId'=$1"+
      " ORDER BY id FOR UPDATE",
      [String(sourceId)],
    );
    let originalArabic=0,remainingLatin=0,truncated=0,changed=0;
    const updates:Array<{id:number;arabic_name:string;search_key:string}>=[];
    for(const card of cards.rows){
      const raw=typeof card.data?.englishName==="string"?card.data.englishName:card.name;
      if(/[\u0600-\u06FF]/.test(raw))originalArabic++;
      let translated=arabizeMarketName(raw);
      if(!translated)continue;
      if(translated.length>300){translated=translated.slice(0,298).trimEnd()+"…";truncated++;}
      if(/[A-Za-z]/.test(translated))remainingLatin++;
      if(translated!==card.name){
        updates.push({id:card.id,arabic_name:translated,search_key:normalizedArabicSearch(translated)});
      }
    }
    for(let n=0;n<updates.length;n+=800){
      const batch=updates.slice(n,n+800);
      const result=await db.query(
        "WITH entries AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id integer,arabic_name text,search_key text))"+
        " UPDATE medicine_market_cards c SET name=x.arabic_name,"+
        " data=c.data || jsonb_build_object('arabicSearchKey',x.search_key,'arabicNameAutoGenerated',true,"+
        " 'arabicNameEngine','phonetic-lexicon-v1','arabicNameNeedsReview',true),"+
        " revision=c.revision+1,updated_at=now()"+
        " FROM entries x WHERE c.id=x.id AND c.kind='medicine'"+
        " AND c.status='published' AND NOT c.archived"+
        " AND c.data->>'importSourceId'=$2 AND c.name IS DISTINCT FROM x.arabic_name",
        [JSON.stringify(batch),String(sourceId)],
      );
      changed+=result.rowCount??0;
    }
    if(changed!==updates.length)throw new Error("arabization_changed_count_mismatch");
    await db.query(
      "UPDATE market_card_arabization_runs SET status='complete',"+
      " total=$2,changed=$3,original_arabic=$4,remaining_latin=$5,truncated=$6,"+
      " error_code=NULL,updated_at=now() WHERE id=$1",
      [runId,cards.rows.length,changed,originalArabic,remainingLatin,truncated],
    );
    await db.query(
      "INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)"+
      " VALUES($1,$2,'public',NULL,'medicine-market.bulk_arabize_ibn_hayyan','medicine-market',NULL,NULL,$3::jsonb)",
      [actorId,actorName,JSON.stringify({runId,sourceId,total:cards.rows.length,changed,originalArabic,remainingLatin,truncated,engine:"phonetic-lexicon-v1"})],
    );
    await db.query("COMMIT");inTransaction=false;
  }catch(err){
    if(inTransaction){try{await db.query("ROLLBACK");}catch{/* disconnected */}}
    try{await pool.query("UPDATE market_card_arabization_runs SET status='failed',error_code='arabization_failed',updated_at=now() WHERE id=$1 AND status='running'",[runId]);}catch{/* check logs */}
    console.error("MARKET_ARABIZATION_FAILED",err instanceof Error?err.message:"internal");
  }finally{db.release();}
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
    res.json({jobs:jobs.rows,sources:sources.rows,stagingVersion:"20261107-title-case"});
  }));
  router.post("/medicine-market/staging/:sourceId/promote-medicines",handler(async(req,res)=>{
    const u=await access.viewer(pool,req,true);
    if(!u?.owner || u.suspended || u.archived)deny();
    await access.enabled(pool,req);
    if(!isolated)throw new HttpError(503,"market_isolation_required","الترحيل متاح في قاعدة السوق المنفصلة فقط");
    const sourceId=parse(z.coerce.number().int().positive(),req.params.sourceId);
    const input=parse(bulkMedicinePromotionSchema,req.body);
    const source=await pool.query(
      "SELECT s.id,s.filename,s.row_count,j.status FROM market_import_sources s JOIN market_import_jobs j ON j.id=s.job_id WHERE s.id=$1",
      [sourceId],
    );
    if(!source.rowCount || source.rows[0].status!=="complete" || !String(source.rows[0].filename).includes("ابن حيان"))
      throw new HttpError(400,"invalid_source","يجب اختيار مصدر ابن حيان المكتمل في جدول السوق المؤقت");
    const prior=await pool.query("SELECT * FROM market_card_import_runs WHERE source_id=$1",[sourceId]);
    if(prior.rowCount){res.status(prior.rows[0].status==="running"?202:200).json(prior.rows[0]);return;}
    await pool.query(
      "INSERT INTO market_card_import_runs(id,source_id,actor_id,status) VALUES($1,$2,$3,'running')",
      [input.idempotencyKey,sourceId,u.id],
    );
    void promoteStagedMedicines(pool,sourceId,input.idempotencyKey,u.id,u.displayName);
    res.status(202).json({id:input.idempotencyKey,sourceId,status:"running"});
  }));
  router.get("/medicine-market/staging/:sourceId/promote-status",handler(async(req,res)=>{
    await authorize(req);
    const sourceId=parse(z.coerce.number().int().positive(),req.params.sourceId);
    const run=await pool.query("SELECT * FROM market_card_import_runs WHERE source_id=$1",[sourceId]);
    if(!run.rowCount)missing();
    res.json(run.rows[0]);
  }));

  router.post("/medicine-market/staging/:sourceId/title-case",handler(async(req,res)=>{
    const u=await access.viewer(pool,req,true);
    if(!u?.owner || u.suspended || u.archived)deny();
    await access.enabled(pool,req);
    if(!isolated)throw new HttpError(503,"market_isolation_required","التعديل الجماعي متاح في قاعدة السوق المنفصلة فقط");
    const sourceId=parse(z.coerce.number().int().positive(),req.params.sourceId);
    const input=parse(bulkMedicinePromotionSchema,req.body);
    const source=await pool.query(
      "SELECT s.filename,j.status FROM market_import_sources s JOIN market_import_jobs j ON j.id=s.job_id WHERE s.id=$1",
      [sourceId],
    );
    if(!source.rowCount || source.rows[0].status!=="complete" || !String(source.rows[0].filename).includes("ابن حيان"))
      throw new HttpError(400,"invalid_source","المصدر يجب أن يكون جدول ابن حيان المكتمل");
    const result=await pool.query(
      "INSERT INTO market_card_name_format_runs(id,source_id,operation,actor_id,status)" +
      " VALUES($1,$2,'title_case',$3,'running') ON CONFLICT(source_id,operation) DO NOTHING RETURNING id",
      [input.idempotencyKey,sourceId,u.id],
    );
    if(result.rowCount) {
      void titleCaseImportedMarketNames(pool,sourceId,input.idempotencyKey,u.id,u.displayName);
      res.status(202).json({id:input.idempotencyKey,sourceId,status:"running"});
    } else {
      const prior=await pool.query("SELECT * FROM market_card_name_format_runs WHERE source_id=$1 AND operation='title_case'",[sourceId]);
      res.status(prior.rows[0]?.status==="running"?202:200).json(prior.rows[0]);
    }
  }));
  router.get("/medicine-market/staging/:sourceId/title-case-status",handler(async(req,res)=>{
    await authorize(req);
    const sourceId=parse(z.coerce.number().int().positive(),req.params.sourceId);
    const run=await pool.query("SELECT * FROM market_card_name_format_runs WHERE source_id=$1 AND operation='title_case'",[sourceId]);
    if(!run.rowCount)missing();
    res.json(run.rows[0]);
  }));

  router.get("/medicine-market/staging/:sourceId/arabize-preview",handler(async(req,res)=>{
    await authorize(req);
    const sourceId=parse(z.coerce.number().int().positive(),req.params.sourceId);
    const rows=await pool.query<{id:number;name:string;data:Record<string,unknown>}>(
      "WITH numbered AS (SELECT id,name,data,row_number() OVER (ORDER BY id DESC) AS rn"+
      " FROM medicine_market_cards WHERE kind='medicine' AND status='published' AND NOT archived"+
      " AND data->>'importSourceId'=$1)"+
      " SELECT id,name,data FROM numbered WHERE rn IN (1,3,10,20,50,800,2200,4100,5700,9000,12000,17000,22500,28500) ORDER BY rn",
      [String(sourceId)],
    );
    res.json({engine:"phonetic-lexicon-v1",items:rows.rows.map(x=>({
      id:x.id,original:x.data.englishName??x.name,arabic:arabizeMarketName(String(x.data.englishName??x.name)),
    }))});
  }));
  router.post("/medicine-market/staging/:sourceId/arabize",handler(async(req,res)=>{
    const user=await authorize(req);
    const sourceId=parse(z.coerce.number().int().positive(),req.params.sourceId);
    const input=parse(bulkMedicinePromotionSchema,req.body);
    const source=await pool.query(
      "SELECT s.filename,j.status FROM market_import_sources s JOIN market_import_jobs j ON j.id=s.job_id WHERE s.id=$1",
      [sourceId],
    );
    if(!source.rowCount||source.rows[0].status!=="complete"||
       !String(source.rows[0].filename).includes("ابن حيان"))
      throw new HttpError(400,"invalid_source","المصدر يجب أن يكون جدول ابن حيان المكتمل");
    const inserted=await pool.query(
      "INSERT INTO market_card_arabization_runs(id,source_id,actor_id,status)"+
      " VALUES($1,$2,$3,'running') ON CONFLICT(source_id) DO NOTHING RETURNING id",
      [input.idempotencyKey,sourceId,user.id],
    );
    if(!inserted.rowCount){
      const previous=await pool.query("SELECT * FROM market_card_arabization_runs WHERE source_id=$1",[sourceId]);
      res.status(previous.rows[0].status==="running"?202:200).json(previous.rows[0]);return;
    }
    void arabizeImportedMarketNames(pool,sourceId,input.idempotencyKey,user.id,user.displayName);
    res.status(202).json({id:input.idempotencyKey,sourceId,status:"running"});
  }));
  router.get("/medicine-market/staging/:sourceId/arabize-status",handler(async(req,res)=>{
    await authorize(req);
    const sourceId=parse(z.coerce.number().int().positive(),req.params.sourceId);
    const prior=await pool.query("SELECT * FROM market_card_arabization_runs WHERE source_id=$1",[sourceId]);
    if(!prior.rowCount)missing();
    res.json(prior.rows[0]);
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
