import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { documentDateSchema } from "../../../packages/contracts/src/finance.ts";
import { HttpError } from "./errors.ts";

/**
 * Read-only overlay of source-preserved invoices. It never inserts into invoices,
 * invoice_lines, stock_movements or financial_documents. Posted source identities
 * are excluded, so the same invoice can never appear twice.
 */
async function readStaged<T>(
  pool: Pool, req: Request, permission: "commerce.view" | "inventory.view",
  action: (client: PoolClient, companyId: number) => Promise<T>,
): Promise<T> {
  return transaction(pool, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const companyId = id(req.params.companyId);
    const user = await currentActor(client, actor(req), false);
    await companyAccess(client, user, companyId, permission);
    return action(client, companyId);
  });
}

const unposted = [
  " FROM legacy_import_staging s",
  " WHERE s.company_id=$1 AND s.source_kind='invoice'",
  " AND s.status IN ('pending','failed','excluded')",
  " AND s.source_document->>'type'='invoice'",
  " AND NOT EXISTS (SELECT 1 FROM transaction_source_imports posted",
  " WHERE posted.company_id=s.company_id AND posted.source_system=s.source_system",
  " AND posted.source_kind=s.source_kind AND posted.source_id=s.source_id)",
].join(" ");

const invoiceJoins = [
  " LEFT JOIN company_currencies cur ON cur.company_id=s.company_id",
  " AND cur.id=(s.source_document->'payload'->>'currencyId')::integer",
  " LEFT JOIN accounts payer ON payer.company_id=s.company_id",
  " AND payer.id=(s.source_document->'payload'->>'counterpartyAccountId')::integer",
  " LEFT JOIN accounts supplier ON supplier.company_id=s.company_id",
  " AND supplier.id=(s.source_document->'payload'->>'supplierAccountId')::integer",
  " LEFT JOIN locations location ON location.company_id=s.company_id",
  " AND location.id=(s.source_document->'payload'->>'locationId')::integer",
].join(" ");

// A separate staged-source search keeps the live invoice list untouched.
export function stagedInvoiceReadRoutes(pool: Pool): Router {
  const router = Router();
  const base = "/companies/:companyId";

  router.get(base + "/staged-invoices", handler(async (req, res) => {
    const result = await readStaged(pool, req, "commerce.view", async (client, companyId) => {
      const page = listQuery(req.query, {
        id: "s.source_id", documentDate: "s.posting_date",
      }, "documentDate:desc,id:desc");
      const kind = req.query.kind === undefined ? null
        : parse(z.enum(["sale","purchase"]), req.query.kind);
      const from = req.query.dateFrom === undefined ? null
        : parse(documentDateSchema, req.query.dateFrom);
      const to = req.query.dateTo === undefined ? null
        : parse(documentDateSchema, req.query.dateTo);
      if (from && to && from > to)
        throw new HttpError(400,"invalid_query","بداية الفترة تتجاوز نهايتها");
      const supplierQ = req.query.supplierQ === undefined ? "" :
        parse(z.string().max(120),req.query.supplierQ);
      const payerQ = req.query.payerQ === undefined ? "" :
        parse(z.string().max(120),req.query.payerQ);
      const locationId = req.query.locationId === undefined ? null : id(String(req.query.locationId));
      const branchId = req.query.branchId === undefined ? null : id(String(req.query.branchId));
      const values = [companyId,searchPattern(page.q),kind,from,to,
        searchPattern(supplierQ),searchPattern(payerQ),locationId,branchId];
      const filters = [
        " AND (s.source_id ILIKE $2 OR s.source_document->>'sourceDocumentNumber' ILIKE $2",
        " OR s.source_document->'payload'->>'description' ILIKE $2",
        " OR s.source_document->'payload'->>'supplierReceiptNumber' ILIKE $2)",
        " AND ($3::text IS NULL OR s.source_document->'payload'->>'kind'=$3)",
        " AND ($4::date IS NULL OR s.posting_date >= $4::date)",
        " AND ($5::date IS NULL OR s.posting_date <= $5::date)",
        " AND (COALESCE(supplier.name,'') ILIKE $6 OR COALESCE(supplier.code,'') ILIKE $6)",
        " AND (COALESCE(payer.name,'') ILIKE $7 OR COALESCE(payer.code,'') ILIKE $7)",
        " AND ($8::integer IS NULL OR (s.source_document->'payload'->>'locationId')::integer=$8)",
        " AND ($9::integer IS NULL OR (s.source_document->'payload'->>'branchId')::integer=$9)",
      ].join(" ");
      const fromSql = " FROM legacy_import_staging s " + invoiceJoins +
        unposted.slice(" FROM legacy_import_staging s".length) + filters;
      const count = await client.query(
        "SELECT count(*)::integer AS total " + fromSql, values);
      const rows = await client.query([
        "SELECT s.source_system AS \"sourceSystem\",s.source_id AS \"sourceId\",",
        " s.source_document->>'sourceDocumentNumber' AS \"number\",",
        " s.source_document->'payload'->>'kind' AS kind,",
        " s.posting_date::text AS \"documentDate\",s.status AS \"stageStatus\",",
        " s.source_document->'payload'->>'supplierReceiptNumber' AS \"supplierReceiptNumber\",",
        " s.source_document->'payload'->>'description' AS description,",
        " s.source_document->>'sourceCreatedAt' AS \"sourceCreatedAt\",",
        " payer.name AS \"counterpartyAccountName\",supplier.name AS \"supplierAccountName\",",
        " location.name AS \"locationName\",cur.code AS \"currencyCode\",",
        " jsonb_array_length(COALESCE(s.source_document->'payload'->'lines','[]'::jsonb)) AS \"lineCount\",",
        " (SELECT (COALESCE(sum((line.value->>'quantity')::numeric *",
        " (line.value->>'unitPrice')::numeric),0) -",
        " COALESCE(NULLIF(s.source_document->'payload'->>'discount','')::numeric,0))::text",
        " FROM jsonb_array_elements(s.source_document->'payload'->'lines') AS line(value)) AS \"estimatedTotal\"",
        fromSql," ORDER BY "+page.order+" LIMIT $10 OFFSET $11",
      ].join(" "), [...values,page.pageSize,page.offset]);
      return {items:rows.rows,total:count.rows[0].total,page:page.page,pageSize:page.pageSize};
    });
    res.json(result);
  }));

  router.get(base + "/staged-invoices/:sourceSystem/:sourceId",handler(async(req,res)=>{
    const result = await readStaged(pool,req,"commerce.view",async(client,companyId)=>{
      const sourceSystem=parse(z.string().min(1).max(100),req.params.sourceSystem);
      const sourceId=parse(z.string().min(1).max(100),req.params.sourceId);
      const header=await client.query(
        "SELECT s.source_system AS \"sourceSystem\",s.source_id AS \"sourceId\",s.source_document->>'sourceDocumentNumber' AS number,s.posting_date::text AS \"documentDate\",s.status AS \"stageStatus\",s.source_document->'payload' AS payload" +
        unposted +
        " AND s.source_system=$2 AND s.source_id=$3",
        [companyId,sourceSystem,sourceId]);
      if (!header.rowCount) throw new HttpError(404,"not_found","الفاتورة الأولية غير موجودة أو تم ترحيلها");
      const lines=await client.query([
        "SELECT line.ordinality::integer AS \"lineNumber\",(line.value->>'itemId')::integer AS \"itemId\",",
        " item.code AS \"itemCode\",item.name AS \"itemName\",",
        " (line.value->>'unit')::integer AS unit,",
        " CASE (line.value->>'unit')::integer WHEN 1 THEN item.unit1_name",
        " WHEN 2 THEN item.unit2_name ELSE item.unit3_name END AS \"unitName\",",
        " line.value->>'quantity' AS quantity,line.value->>'unitPrice' AS \"unitPrice\",",
        " line.value->>'expiryDate' AS \"expiryDate\"",
        " FROM legacy_import_staging s CROSS JOIN LATERAL",
        " jsonb_array_elements(s.source_document->'payload'->'lines') WITH ORDINALITY AS line(value,ordinality)",
        " LEFT JOIN items item ON item.company_id=s.company_id AND item.id=(line.value->>'itemId')::integer",
        " WHERE s.company_id=$1 AND s.source_system=$2 AND s.source_id=$3",
        " ORDER BY line.ordinality",
      ].join(" "),[companyId,sourceSystem,sourceId]);
      const {payload,...invoice}=header.rows[0];
      return {invoice:{...invoice,kind:payload.kind,description:payload.description,
        supplierReceiptNumber:payload.supplierReceiptNumber,currencyId:payload.currencyId,
        discount:payload.discount,lines:lines.rows}};
    });
    res.json(result);
  }));

  router.get(base + "/staged-stock-movements",handler(async(req,res)=>{
    const result=await readStaged(pool,req,"inventory.view",async(client,companyId)=>{
      const page=listQuery(req.query,{
        id:"s.source_id",documentDate:"s.posting_date",
      },"documentDate:desc,id:desc");
      const kind=req.query.kind===undefined ? null :
        parse(z.enum(["sale","purchase"]),req.query.kind);
      const from=req.query.dateFrom===undefined?null:parse(documentDateSchema,req.query.dateFrom);
      const to=req.query.dateTo===undefined?null:parse(documentDateSchema,req.query.dateTo);
      if(from && to && from>to)throw new HttpError(400,"invalid_query","بداية الفترة تتجاوز نهايتها");
      const itemId=req.query.itemId===undefined?null:id(String(req.query.itemId));
      const locationId=req.query.locationId===undefined?null:id(String(req.query.locationId));
      const supplierAccountId=req.query.supplierAccountId===undefined?null:id(String(req.query.supplierAccountId));
      const doctorId=req.query.doctorId===undefined?null:id(String(req.query.doctorId));
      const values=[companyId,searchPattern(page.q),kind,from,to,itemId,locationId,supplierAccountId,doctorId];
      const joined=[
        " FROM legacy_import_staging s",
        " CROSS JOIN LATERAL jsonb_array_elements(s.source_document->'payload'->'lines')",
        " WITH ORDINALITY AS line(value,ordinality)",
        " LEFT JOIN items item ON item.company_id=s.company_id",
        " AND item.id=(line.value->>'itemId')::integer",
        " LEFT JOIN locations location ON location.company_id=s.company_id",
        " AND location.id=(s.source_document->'payload'->>'locationId')::integer",
        " LEFT JOIN accounts supplier ON supplier.company_id=s.company_id",
        " AND supplier.id=(s.source_document->'payload'->>'supplierAccountId')::integer",
      ].join(" ");
      const filters=[
        unposted.slice(" FROM legacy_import_staging s".length),
        " AND (s.source_id ILIKE $2 OR item.code ILIKE $2 OR item.name ILIKE $2",
        " OR s.source_document->'payload'->>'description' ILIKE $2)",
        " AND ($3::text IS NULL OR s.source_document->'payload'->>'kind'=$3)",
        " AND ($4::date IS NULL OR s.posting_date >= $4::date)",
        " AND ($5::date IS NULL OR s.posting_date <= $5::date)",
        " AND ($6::integer IS NULL OR (line.value->>'itemId')::integer=$6)",
        " AND ($7::integer IS NULL OR (s.source_document->'payload'->>'locationId')::integer=$7)",
        " AND ($8::integer IS NULL OR (s.source_document->'payload'->>'supplierAccountId')::integer=$8)",
        " AND ($9::integer IS NULL OR (s.source_document->'payload'->>'doctorId')::integer=$9)",
      ].join(" ");
      const count=await client.query("SELECT count(*)::integer AS total"+joined+filters,values);
      const rows=await client.query([
        "SELECT s.source_system AS \"sourceSystem\",s.source_id AS \"sourceId\",",
        " s.source_document->>'sourceDocumentNumber' AS \"invoiceNumber\",",
        " s.posting_date::text AS \"documentDate\",s.status AS \"stageStatus\",",
        " s.source_document->'payload'->>'kind' AS kind,",
        " line.ordinality::integer AS \"lineNumber\",item.code AS \"itemCode\",item.name AS \"itemName\",",
        " location.name AS \"locationName\",supplier.name AS \"supplierAccountName\",",
        " line.value->>'quantity' AS quantity,line.value->>'unitPrice' AS \"unitPrice\",",
        " (CASE WHEN s.source_document->'payload'->>'kind'='sale' THEN -1 ELSE 1 END *",
        " (line.value->>'quantity')::numeric *",
        " CASE (line.value->>'unit')::integer WHEN 1 THEN item.factor2*item.factor3",
        " WHEN 2 THEN item.factor3 ELSE 1 END)::text AS \"quantitySmallest\",",
        " line.value->>'expiryDate' AS \"expiryDate\"",
        joined,filters," ORDER BY "+page.order+",line.ordinality DESC LIMIT $10 OFFSET $11",
      ].join(" "),[...values,page.pageSize,page.offset]);
      return {items:rows.rows,total:count.rows[0].total,page:page.page,pageSize:page.pageSize};
    });
    res.json(result);
  }));
  return router;
}
