import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";

type StagedDocument = {
  type: "invoice" | "voucher";
  sourceId: string;
  sourceDocumentNumber: string;
  sourceCreatedAt: string;
  sourceCreators: string[];
  payload: { documentDate: string; description: string; kind: string };
};
type Batch = {
  idempotencyKey: string;
  sourceSystem: string;
  postingDate: string;
  documents: StagedDocument[];
};
const sourceType = z.enum(["invoice", "voucher"]);
const sourceReference = z.object({ type: sourceType, sourceId: z.string().min(1).max(100) }).strict();
const receiptSchema = z.object({
  sourceSystem: z.string().trim().min(1).max(100),
  completed: z.array(sourceReference).max(300),
  failed: z.array(sourceReference.extend({message:z.string().max(1000)})).max(300),
}).strict();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
      .map(([key,item])=>[key,canonical(item)]));
  return value;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
async function assertOwner(client:PoolClient, req:any, companyId:number, requireWrite=false) {
  const user=await currentActor(client,actor(req));
  ownerOnly(user);
  if(user.suspended)throw new HttpError(403,"forbidden","الحساب موقوف");
  await companyAccess(client,user,companyId,undefined,requireWrite);
  if(requireWrite) await assertRequestPagesEnabled(client,req,true);
  return user;
}

/** A staged document is NOT an invoice and never changes stock, journals or notifications. */
export function transactionImportStagingRoutes(pool: Pool, batchSchema: z.ZodTypeAny): Router {
  const router=Router();

  router.post("/companies/:companyId/transaction-import/stage",handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const input=parse(batchSchema,req.body) as Batch;
    const result=await transaction(pool,async client=>{
      const user=await assertOwner(client,req,companyId,true);
      const rows=input.documents.map(doc=>({
        source_kind:doc.type, source_id:doc.sourceId, source_document:doc,
        request_hash:hash(doc),
      }));
      const imported=await client.query(
        "SELECT source_kind,source_id,request_hash FROM transaction_source_imports WHERE company_id=$1 AND source_system=$2 AND source_id=ANY($3::text[])",
        [companyId,input.sourceSystem,rows.map(x=>x.source_id)],
      );
      const prior=await client.query(
        "SELECT source_kind,source_id,request_hash FROM legacy_import_staging WHERE company_id=$1 AND source_system=$2 AND source_id=ANY($3::text[])",
        [companyId,input.sourceSystem,rows.map(x=>x.source_id)],
      );
      const key=(kind:string,sourceId:string)=>kind+":"+sourceId;
      const posted=new Map(imported.rows.map(x=>[key(x.source_kind,x.source_id),x.request_hash]));
      const staged=new Map(prior.rows.map(x=>[key(x.source_kind,x.source_id),x.request_hash]));
      const pending:typeof rows=[];
      let alreadyPosted=0,alreadyStaged=0;
      for(const row of rows){
        const currentKey=key(row.source_kind,row.source_id);
        if(posted.has(currentKey)){
          if(posted.get(currentKey)!==row.request_hash)
            throw new HttpError(409,"source_conflict","الفاتورة المرحّلة سابقًا تختلف عن بيانات المصدر.");
          alreadyPosted++;
        }else if(staged.has(currentKey)){
          if(staged.get(currentKey)!==row.request_hash)
            throw new HttpError(409,"source_conflict","البيانات المحفوظة أوليًا تختلف عن الملف الجديد.");
          alreadyStaged++;
        }else pending.push(row);
      }
      const inserted=pending.length?await client.query(
        `INSERT INTO legacy_import_staging
         (company_id,source_system,source_kind,source_id,posting_date,source_document,request_hash,created_by)
         SELECT $1,$2,r.source_kind,r.source_id,$3::date,r.source_document,r.request_hash,$5
         FROM jsonb_to_recordset($4::jsonb) AS r(
           source_kind text,source_id text,source_document jsonb,request_hash text)
         ON CONFLICT DO NOTHING RETURNING source_id`,
        [companyId,input.sourceSystem,input.postingDate,JSON.stringify(pending),user.id],
      ):{rowCount:number|null};
      return {staged:inserted.rowCount??0,alreadyStaged:alreadyStaged+pending.length-(inserted.rowCount??0),alreadyPosted};
    });
    res.json(result);
  }));

  router.get("/companies/:companyId/transaction-import/stage-status",handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const result=await transaction(pool,async client=>{
      await assertOwner(client,req,companyId);
      const r=await client.query(
        `SELECT count(*) FILTER (WHERE status='pending')::integer AS pending,
         count(*) FILTER (WHERE status='completed')::integer AS completed,
         count(*) FILTER (WHERE status='failed')::integer AS failed,
         count(*)::integer AS total
         FROM legacy_import_staging WHERE company_id=$1`,[companyId]);
      return r.rows[0];
    });
    res.json(result);
  }));

  router.get("/companies/:companyId/transaction-import/stage-next",handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const result=await transaction(pool,async client=>{
      await assertOwner(client,req,companyId);
      const rows=await client.query(
        `WITH first AS (
            SELECT source_system,posting_date FROM legacy_import_staging
            WHERE company_id=$1 AND status='pending'
            ORDER BY posting_date,source_id LIMIT 1
          )
          SELECT s.source_system,s.posting_date::text AS posting_date,s.source_document
          FROM legacy_import_staging s JOIN first f
          ON s.source_system=f.source_system AND s.posting_date=f.posting_date
          WHERE s.company_id=$1 AND s.status='pending'
          ORDER BY s.source_id LIMIT 20`,[companyId]);
      if(!rows.rows.length)return {batch:null};
      return {batch:{
        idempotencyKey:randomUUID(),
        sourceSystem:rows.rows[0].source_system,
        postingDate:rows.rows[0].posting_date,
        documents:rows.rows.map(row=>row.source_document),
      }};
    });
    res.json(result);
  }));

  router.post("/companies/:companyId/transaction-import/stage-ack",handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const input=parse(receiptSchema,req.body);
    const result=await transaction(pool,async client=>{
      await assertOwner(client,req,companyId,true);
      const completed=await client.query(
        `UPDATE legacy_import_staging s SET status='completed',error_message=NULL,updated_at=clock_timestamp()
         FROM transaction_source_imports m
         WHERE s.company_id=$1 AND s.source_system=$2
           AND m.company_id=s.company_id AND m.source_system=s.source_system
           AND m.source_kind=s.source_kind AND m.source_id=s.source_id
           AND (s.source_kind||':'||s.source_id)=ANY($3::text[])
         RETURNING s.source_id`,
        [companyId,input.sourceSystem,input.completed.map(x=>x.type+":"+x.sourceId)],
      );
      if((completed.rowCount??0)!==input.completed.length)
        throw new HttpError(409,"stage_ack_mismatch","تعذر تأكيد بعض المستندات؛ ستبقى محفوظة لاستكمالها.");
      const failed=input.failed.length?await client.query(
        `UPDATE legacy_import_staging s
         SET status='failed',error_message=f.message,updated_at=clock_timestamp()
         FROM jsonb_to_recordset($3::jsonb) AS f(source_kind text,source_id text,message text)
         WHERE s.company_id=$1 AND s.source_system=$2 AND s.source_kind=f.source_kind AND s.source_id=f.source_id
         RETURNING s.source_id`,
        [companyId,input.sourceSystem,JSON.stringify(input.failed.map(x=>({
          source_kind:x.type,source_id:x.sourceId,message:x.message,
        })))],
      ):{rowCount:number|null};
      return {completed:completed.rowCount??0,failed:failed.rowCount??0};
    });
    res.json(result);
  }));

  router.post("/companies/:companyId/transaction-import/stage-retry-failed",handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const result=await transaction(pool,async client=>{
      await assertOwner(client,req,companyId,true);
      const r=await client.query(
        "UPDATE legacy_import_staging SET status='pending',error_message=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND status='failed'",[companyId]);
      return {retried:r.rowCount??0};
    });
    res.json(result);
  }));
  return router;
}
