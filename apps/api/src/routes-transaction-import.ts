import { transactionImportStagingRoutes } from "./routes-transaction-import-staging.ts";
import { batchSchema } from "./routes-transaction-import-schemas.ts";
import { inflateSync } from "node:zlib";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { importTransactionBatch } from "./services/transaction-import.ts";
import { postNextRawVoucherBatch } from "./services/legacy-voucher-batch.ts";

export function transactionImportRoutes(pool: Pool): Router {
  const router = Router();
  router.use(transactionImportStagingRoutes(pool));
  // Owner-only, bounded migration from the already preserved raw voucher archive.
  // No arbitrary financial rows can be supplied by the caller.
  router.post(
    "/companies/:companyId/transaction-import/raw-vouchers/post-next",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      const input = parse(
        z.object({
          afterRow: z.number().int().min(0).max(100000000).default(0),
          limit: z.number().int().min(1).max(100).default(40),
        }).strict(), req.body,
      );
      const result = await transaction(pool, async client => {
        const user = await currentActor(client, actor(req));
        ownerOnly(user);
        if (user.suspended)
          throw new HttpError(403, "forbidden", "الحساب موقوف");
        await companyAccess(client, user, companyId, undefined, true);
        await assertRequestPagesEnabled(client, req, true);
        return postNextRawVoucherBatch(client, user, companyId, input.afterRow,
          input.limit, documents => assertRequestPagesEnabled(client,
            Object.assign(Object.create(req), { body: { documents } }), true));
      });
      res.json(result);
    }),
  );
  router.get(
    "/companies/:companyId/transaction-import/summary",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      const sourceSystem = parse(
        z.string().trim().min(1).max(100),
        req.query.sourceSystem,
      );
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const user = await currentActor(client, actor(req), false);
        ownerOnly(user);
        if (user.suspended)
          throw new HttpError(403, "forbidden", "الحساب موقوف");
        await companyAccess(client, user, companyId);
        await assertRequestPagesEnabled(client, req);
        const invoices = await client.query(
          `SELECT i.kind,count(*)::integer AS count,COALESCE(sum(i.total),0)::text AS total,
        COALESCE(sum((SELECT count(*) FROM invoice_lines l WHERE l.company_id=i.company_id AND l.invoice_id=i.id)),0)::integer AS lines
        FROM transaction_source_imports s JOIN invoices i ON i.company_id=s.company_id AND i.id=s.invoice_id
        WHERE s.company_id=$1 AND s.source_system=$2 GROUP BY i.kind ORDER BY i.kind`,
          [companyId, sourceSystem],
        );
        const vouchers = await client.query(
          `SELECT d.kind,count(*)::integer AS count,COALESCE(sum(d.total_debit),0)::text AS total
        FROM transaction_source_imports s JOIN financial_documents d ON d.company_id=s.company_id AND d.id=s.financial_document_id
        WHERE s.company_id=$1 AND s.source_system=$2 GROUP BY d.kind ORDER BY d.kind`,
          [companyId, sourceSystem],
        );
        const sources = await client.query(
          `SELECT count(*)::integer AS count,COALESCE(sum(jsonb_array_length(source_metadata->'sourceRows')),0)::integer AS source_rows,
        min(source_metadata->>'sourceCreatedAt') AS first_source_date,max(source_metadata->>'sourceCreatedAt') AS last_source_date
        FROM transaction_source_imports WHERE company_id=$1 AND source_system=$2`,
          [companyId, sourceSystem],
        );
        const ledger = await client.query(
          `SELECT count(*)::integer AS documents,COALESCE(sum(total_base_debit),0)::text AS debit,COALESCE(sum(total_base_credit),0)::text AS credit,
        count(*) FILTER(WHERE total_debit<>total_credit OR total_base_debit<>total_base_credit)::integer AS unbalanced
        FROM financial_documents WHERE company_id=$1 AND status<>'draft'`,
          [companyId],
        );
        return {
          companyId,
          sourceSystem,
          invoices: invoices.rows,
          vouchers: vouchers.rows,
          sources: sources.rows[0],
          ledger: ledger.rows[0],
        };
      });
      res.json(result);
    }),
  );
  router.get("/companies/:companyId/transaction-import/prepared-next-50",handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    if(companyId!==2)throw new HttpError(404,"not_found","لا توجد دفعة لهذه الشركة.");
    await transaction(pool,async client=>{
      const user=await currentActor(client,actor(req),false);
      ownerOnly(user);
      if(user.suspended)throw new HttpError(403,"forbidden","الحساب موقوف");
      await companyAccess(client,user,companyId);
    });
    const encoded=process.env.ALRAESY_PRIVATE_NEXT50_ZLIB;
    if(!encoded)throw new HttpError(404,"not_found","الدفعة الخاصة غير متاحة.");
    const raw=inflateSync(Buffer.from(encoded,"base64"),{maxOutputLength:1_000_000}).toString("utf8");
    const batches=raw.split(/\\r?\\n/).filter(Boolean).map(line=>parse(batchSchema,JSON.parse(line)));
    if(batches.reduce((n,b)=>n+b.documents.length,0)!==50)
      throw new HttpError(500,"invalid_batch","عدد الفواتير في الدفعة غير صحيح.");
    res.setHeader("Cache-Control","private, no-store");
    res.json({batches});
  }));
  // Owner-only URL ingestion. No source file is written to disk or retained.
  router.post("/companies/:companyId/transaction-import/from-url", handler(async (req,res) => {
    const companyId=id(req.params.companyId);
    const input=parse(z.object({url:z.url().max(2000)}).strict(),req.body);
    const target=new URL(input.url);
    if(target.protocol!=="https:"||target.username||target.password||target.port)
      throw new HttpError(400,"invalid_url","يجب استخدام رابط HTTPS آمن.");
    const host=target.hostname.toLowerCase();
    if(!["drive.google.com","docs.google.com","raw.githubusercontent.com","storage.googleapis.com"].includes(host))
      throw new HttpError(400,"invalid_url","مصدر الرابط غير معتمد. استخدم رابط ملف من Google Drive أو تخزين معتمد.");
    await transaction(pool,async client=>{
      const user=await currentActor(client,actor(req));
      ownerOnly(user);
      if(user.suspended)throw new HttpError(403,"forbidden","الحساب موقوف");
      await companyAccess(client,user,companyId,undefined,true);
    });
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),12000);
    let raw="";
    try {
      const response=await fetch(target,{redirect:"error",signal:controller.signal,headers:{Accept:"application/json,text/plain"}});
      if(!response.ok)throw new HttpError(400,"source_unavailable","تعذر قراءة الملف من الرابط.");
      if(Number(response.headers.get("content-length")||0)>3_000_000)throw new HttpError(413,"source_too_large","الملف كبير جدًا.");
      const reader=response.body?.getReader();
      if(!reader)throw new HttpError(400,"source_empty","الملف فارغ.");
      const decoder=new TextDecoder();
      let bytes=0;
      while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
        if(bytes>3_000_000){await reader.cancel();throw new HttpError(413,"source_too_large","الملف كبير جدًا.");}
        raw+=decoder.decode(part.value,{stream:true});
      }
      raw+=decoder.decode();
    }finally{clearTimeout(timeout);}
    let entries:unknown;
    try{entries=raw.trim().startsWith("[")?JSON.parse(raw):raw.trim().split(/\\r?\\n/).filter(Boolean).map(line=>JSON.parse(line));}
    catch{throw new HttpError(400,"invalid_file","تعذر قراءة JSON/JSONL.");}
    if(!Array.isArray(entries)||entries.length<1||entries.length>100)
      throw new HttpError(400,"invalid_file","الملف يجب أن يحتوي على 1 إلى 100 دفعة.");
    const batches=entries.map(value=>parse(batchSchema,value));
    if(batches.some(batch=>batch.documents.some(doc=>doc.type!=="invoice"||doc.payload.kind!=="sale")))
      throw new HttpError(400,"invalid_file","هذه الصفحة لاستيراد المبيعات فقط.");
    res.json({batches});
  }));
  router.post(
    "/companies/:companyId/transaction-import/batch",
    handler(async (req, res) => {
      const input = parse(batchSchema, req.body),
        companyId = id(req.params.companyId);
      const result = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        ownerOnly(user);
        if (user.suspended)
          throw new HttpError(403, "forbidden", "الحساب موقوف");
        await companyAccess(client, user, companyId, undefined, true);
        return importTransactionBatch(client, user, companyId, input, () =>
          assertRequestPagesEnabled(client, req, true),
        );
      });
      res.json(result);
    }),
  );
  return router;
}

