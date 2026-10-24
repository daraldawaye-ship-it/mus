import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import {
  documentDateSchema,
  invoiceSchema,
  invoiceLineSchema,
  financialDocumentSchema,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { audit } from "./services/audit.ts";
import { createInvoice, loadInvoice } from "./services/commerce.ts";
import {
  assertBalanced,
  checkDocumentReferences,
  loadDocument,
} from "./services/finance.ts";
import { insertDraft, postDraft } from "./routes-finance.ts";

const importedInvoiceSchema = invoiceSchema.safeExtend({
  lines: z.array(invoiceLineSchema).min(1).max(200),
});
const sourceFields = {
  sourceId: z.string().min(1).max(100),
  sourceDocumentNumber: z.string().min(1).max(100),
  sourceCreatedAt: z.string().min(1).max(40),
  sourceCreators: z.array(z.string().max(120)).min(1).max(20),
  sourceMovementIds: z.array(z.string().min(1).max(100)).min(1).max(500),
  sourceRows: z
    .array(z.record(z.string().max(120), z.string().max(4000)))
    .min(1)
    .max(200),
};
const importedDocumentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("invoice"),
      ...sourceFields,
      payload: importedInvoiceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("voucher"),
      ...sourceFields,
      payload: financialDocumentSchema,
    })
    .strict(),
]);
const batchSchema = z
  .object({
    idempotencyKey: z.uuid(),
    sourceSystem: z.string().trim().min(1).max(100),
    postingDate: documentDateSchema,
    documents: z.array(importedDocumentSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.documents.forEach((doc, index) => {
      const key = doc.type + ":" + doc.sourceId;
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: ["documents", index, "sourceId"],
          message: "هوية المصدر مكررة داخل الدفعة",
        });
      seen.add(key);
      if (doc.payload.documentDate !== value.postingDate)
        context.addIssue({
          code: "custom",
          path: ["documents", index, "payload", "documentDate"],
          message: "تاريخ المستند يجب أن يطابق تاريخ ترحيل الدفعة",
        });
    });
  });
export const mcpBodySchemas = { batchSchema };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
type ImportSummary = {
  type: "invoice" | "voucher";
  sourceId: string;
  id: number;
  number: string;
  total: string;
};
type ImportFailure = {
  type: "invoice" | "voucher";
  sourceId: string;
  code: string;
  message: string;
};

export function transactionImportRoutes(pool: Pool): Router {
  const router = Router();
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
        companyId = id(req.params.companyId),
        hash = fingerprint(input);
      const result = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        ownerOnly(user);
        if (user.suspended)
          throw new HttpError(403, "forbidden", "الحساب موقوف");
        await companyAccess(client, user, companyId, undefined, true);
        const previous = (
          await client.query(
            "SELECT * FROM transaction_import_batches WHERE company_id=$1 AND idempotency_key=$2",
            [companyId, input.idempotencyKey],
          )
        ).rows[0];
        if (previous) {
          if (previous.created_by !== user.id || previous.request_hash !== hash)
            throw new HttpError(
              409,
              "conflict",
              "استُخدم مفتاح الدفعة لبيانات مختلفة",
            );
          return { ...previous.result, replayed: true };
        }
        await assertRequestPagesEnabled(client, req, true);
        const imported: ImportSummary[] = [],
          existing: ImportSummary[] = [],
          failed: ImportFailure[] = [];
        for (const source of input.documents) {
          await client.query("SAVEPOINT transaction_import_document");
          try {
            const recordHash = fingerprint(source);
            const mapped = (
              await client.query(
                "SELECT * FROM transaction_source_imports WHERE company_id=$1 AND source_system=$2 AND source_kind=$3 AND source_id=$4",
                [companyId, input.sourceSystem, source.type, source.sourceId],
              )
            ).rows[0];
            if (mapped) {
              if (
                mapped.created_by !== user.id ||
                mapped.request_hash !== recordHash
              )
                throw new HttpError(
                  409,
                  "source_conflict",
                  "سبق ترحيل هوية المصدر ببيانات مختلفة",
                );
              const document =
                source.type === "invoice"
                  ? await loadInvoice(client, companyId, mapped.invoice_id)
                  : await loadDocument(
                      client,
                      companyId,
                      mapped.financial_document_id,
                    );
              existing.push({
                type: source.type,
                sourceId: source.sourceId,
                id: document.id,
                number: document.number,
                total:
                  "total" in document ? document.total : document.totalDebit,
              });
              await client.query(
                "RELEASE SAVEPOINT transaction_import_document",
              );
              continue;
            }
            const table =
              source.type === "invoice" ? "invoices" : "financial_documents";
            const occupied = await client.query(
              `SELECT 1 FROM ${table} WHERE company_id=$1 AND idempotency_key=$2`,
              [companyId, source.payload.idempotencyKey],
            );
            if (occupied.rowCount)
              throw new HttpError(
                409,
                "source_key_conflict",
                "مفتاح المستند مرتبط بحركة سابقة خارج هذه الهوية",
              );
            const reference = `ترحيل تاريخي | المصدر ${input.sourceSystem} | الرقم السابق ${source.sourceDocumentNumber} | التاريخ السابق ${source.sourceCreatedAt} | المستخدم الأصلي ${source.sourceCreators.join("، ")}`;
            const description = (
              reference +
              " | " +
              source.payload.description
            ).slice(0, 1000);
            let summary: ImportSummary;
            if (source.type === "invoice") {
              const invoice = await createInvoice(
                client,
                companyId,
                user,
                { ...source.payload, description },
                {
                  allowHistoricalPrice: true,
                  allowUnknownExpiry: true,
                  suppressRewards: true,
                  allowHistoricalStockChronology: true,
                  allowExpenseCounterparty: true,
                },
              );
              summary = {
                type: source.type,
                sourceId: source.sourceId,
                id: invoice.id,
                number: invoice.number,
                total: invoice.total,
              };
            } else {
              const payload = { ...source.payload, description };
              await checkDocumentReferences(client, companyId, payload);
              assertBalanced(payload.lines);
              const documentId = await insertDraft(
                client,
                companyId,
                user,
                payload,
                payload.idempotencyKey,
                payload,
              );
              await postDraft(client, companyId, documentId, user);
              const document = await loadDocument(
                client,
                companyId,
                documentId,
              );
              await audit(
                client,
                user,
                "financialDocument.post",
                "financialDocument",
                documentId,
                null,
                document,
                companyId,
              );
              summary = {
                type: source.type,
                sourceId: source.sourceId,
                id: document.id,
                number: document.number,
                total: document.totalDebit,
              };
            }
            const { payload: unused, ...metadata } = source;
            await client.query(
              "INSERT INTO transaction_source_imports(company_id,source_system,source_kind,source_id,created_by,request_hash,source_metadata,invoice_id,financial_document_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              [
                companyId,
                input.sourceSystem,
                source.type,
                source.sourceId,
                user.id,
                recordHash,
                JSON.stringify(metadata),
                source.type === "invoice" ? summary.id : null,
                source.type === "voucher" ? summary.id : null,
              ],
            );
            // Force deferred accounting/stock checks inside this savepoint. A bad
            // document cannot poison the successful documents in the same batch.
            await client.query("SET CONSTRAINTS ALL IMMEDIATE");
            await client.query("SET CONSTRAINTS ALL DEFERRED");
            await client.query("RELEASE SAVEPOINT transaction_import_document");
            imported.push(summary);
          } catch (error) {
            await client.query(
              "ROLLBACK TO SAVEPOINT transaction_import_document",
            );
            await client.query("RELEASE SAVEPOINT transaction_import_document");
            failed.push({
              type: source.type,
              sourceId: source.sourceId,
              code: error instanceof HttpError ? error.code : "import_failed",
              message:
                error instanceof HttpError
                  ? error.message
                  : "تعذر ترحيل المستند؛ لم يُحفظ أي جزء منه",
            });
            if (!(error instanceof HttpError))
              console.error(
                "Historical transaction import failed",
                source.type,
                source.sourceId,
                error,
              );
          }
        }
        const result = {
          companyId,
          sourceSystem: input.sourceSystem,
          postingDate: input.postingDate,
          imported,
          existing,
          failed,
        };
        await audit(
          client,
          user,
          "company.transactions.import",
          "company",
          companyId,
          null,
          {
            sourceSystem: input.sourceSystem,
            postingDate: input.postingDate,
            imported: imported.length,
            existing: existing.length,
            failed: failed.length,
          },
          companyId,
        );
        await client.query(
          "INSERT INTO transaction_import_batches(company_id,idempotency_key,created_by,request_hash,result) VALUES($1,$2,$3,$4,$5)",
          [
            companyId,
            input.idempotencyKey,
            user.id,
            hash,
            JSON.stringify(result),
          ],
        );
        return { ...result, replayed: false };
      });
      res.json(result);
    }),
  );
  return router;
}
