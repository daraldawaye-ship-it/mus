import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { HttpError, missing } from "./errors.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { audit } from "./services/audit.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";

const bulkImportSchema = z.object({
  idempotencyKey: z.uuid(),
  sourceSystem: z.string().trim().min(1).max(100),
  roundUnitPrices: z.boolean(),
}).strict();
const bulkImportActionSchema = z.object({action:z.enum(["pause","resume","finish"])}).strict();
export const mcpBodySchemas = {bulkImportSchema,bulkImportActionSchema};

export async function loadLegacyImportRun(client:PoolClient,companyId:number,key:string) {
  const row=(await client.query(`SELECT idempotency_key AS "idempotencyKey",
    company_id AS "companyId",source_system AS "sourceSystem",status,phase,
    initial_pending AS "initialPending",imported,existing,failed_documents AS "failedDocuments",
    rounded,last_posting_date::text AS "lastPostingDate",last_source_id AS "lastSourceId",
    error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt",
    finished_at AS "finishedAt" FROM legacy_import_runs WHERE company_id=$1 AND idempotency_key=$2`,
    [companyId,key])).rows[0];
  if(!row)missing();
  return row;
}

export function legacyImportRunRoutes(pool:Pool):Router {
  const router=Router();
  router.post("/companies/:companyId/transaction-import/bulk",handler(async(req,res)=>{
    const companyId=id(req.params.companyId),input=parse(bulkImportSchema,req.body);
    const result=await transaction(pool,async client=>{
      const user=await currentActor(client,actor(req));ownerOnly(user);
      if(user.suspended)throw new HttpError(403,"forbidden","الحساب موقوف");
      await client.query("SELECT set_config('alraesy.legacy_import_run',$1,true)",[input.idempotencyKey]);
      await companyAccess(client,user,companyId,undefined,true);
      const prior=(await client.query(`SELECT created_by,request_payload=$3::jsonb AS same_payload
        FROM legacy_import_runs WHERE company_id=$1 AND idempotency_key=$2`,
        [companyId,input.idempotencyKey,JSON.stringify(input)])).rows[0];
      if(prior){
        if(prior.created_by!==user.id||!prior.same_payload)
          throw new HttpError(409,"conflict","استُخدم مفتاح مهمة الترحيل لطلب مختلف");
        return {run:await loadLegacyImportRun(client,companyId,input.idempotencyKey),replayed:true};
      }
      await assertRequestPagesEnabled(client,req,true);
      // A new authorized run may revisit failed intake without modifying its source.
      await client.query(`UPDATE legacy_import_staging SET status='pending',error_message=NULL,
        updated_at=clock_timestamp() WHERE company_id=$1 AND source_system=$2
        AND source_kind='invoice' AND status='failed'`,[companyId,input.sourceSystem]);
      const count=(await client.query(`SELECT count(*)::integer AS count FROM legacy_import_staging
        WHERE company_id=$1 AND source_system=$2 AND source_kind='invoice' AND status='pending'`,
        [companyId,input.sourceSystem])).rows[0].count;
      if(!count)throw new HttpError(409,"no_pending_invoices","لا توجد فواتير معلقة لهذا المصدر");
      await client.query(`INSERT INTO legacy_import_runs
        (company_id,idempotency_key,source_system,created_by,request_payload,round_unit_prices,initial_pending)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[companyId,input.idempotencyKey,input.sourceSystem,
        user.id,JSON.stringify(input),input.roundUnitPrices,count]);
      await audit(client,user,"company.transactions.bulk-start","company",companyId,null,
        {idempotencyKey:input.idempotencyKey,sourceSystem:input.sourceSystem,initialPending:count,
          roundUnitPrices:input.roundUnitPrices},companyId);
      return {run:await loadLegacyImportRun(client,companyId,input.idempotencyKey),replayed:false};
    });
    res.status(202).json(result);
  }));
  router.get("/companies/:companyId/transaction-import/bulk/:idempotencyKey",handler(async(req,res)=>{
    const companyId=id(req.params.companyId),key=parse(z.uuid(),req.params.idempotencyKey);
    const run=await transaction(pool,async client=>{
      const user=await currentActor(client,actor(req),false);ownerOnly(user);
      if(user.suspended)throw new HttpError(403,"forbidden","الحساب موقوف");
      await client.query("SELECT set_config('alraesy.legacy_import_run',$1,true)",[key]);
      await companyAccess(client,user,companyId);
      return loadLegacyImportRun(client,companyId,key);
    });
    res.json({run});
  }));
  router.post("/companies/:companyId/transaction-import/bulk/:idempotencyKey/actions",handler(async(req,res)=>{
    const companyId=id(req.params.companyId),key=parse(z.uuid(),req.params.idempotencyKey),
      input=parse(bulkImportActionSchema,req.body);
    const run=await transaction(pool,async client=>{
      const user=await currentActor(client,actor(req));ownerOnly(user);
      if(user.suspended)throw new HttpError(403,"forbidden","الحساب موقوف");
      await client.query("SELECT set_config('alraesy.legacy_import_run',$1,true)",[key]);
      await companyAccess(client,user,companyId,undefined,true);
      const old=await loadLegacyImportRun(client,companyId,key);
      if(old.status==="completed")return old;
      const status=input.action==="finish"?"rebuilding":input.action==="pause"?"paused":
        old.phase==="rebuilding"?"rebuilding":"running";
      await client.query(`UPDATE legacy_import_runs SET status=$3,
        phase=CASE WHEN $3='rebuilding' THEN 'rebuilding' ELSE phase END,
        error_message=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND idempotency_key=$2`,
        [companyId,key,status]);
      await audit(client,user,"company.transactions.bulk-action","company",companyId,
        {idempotencyKey:key,status:old.status},{idempotencyKey:key,status,action:input.action},companyId);
      return loadLegacyImportRun(client,companyId,key);
    });res.json({run});
  }));
  return router;
}
