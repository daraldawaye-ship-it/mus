import type { PoolClient } from "pg";
import { z } from "zod";
import { normalizeDigits, type User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { audit } from "./audit.ts";
import { directoryEntries } from "./pages.ts";

export const salesCorrectionListSchema=z.object({
  page:z.coerce.number().int().min(1).max(10000).default(1),
  pageSize:z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const sourceKeySchema=z.string().min(5).max(850);
const correctedSchema=z.string().trim().transform(value=>normalizeDigits(value).replace(/^−/,"-"))
  .pipe(z.string().regex(/^[+-]?\d{1,22}(?:\.\d{1,4})?$/,"أدخل كمية موقّعة حتى أربع منازل عشرية"));
export const salesCorrectionPatchSchema=z.object({
  sourceKey:sourceKeySchema, correctedQuantity:correctedSchema.nullable(),
  expectedRevision:z.number().int().min(0).max(2147483646), reason:z.string().trim().min(1).max(500),
}).strict();

export async function assertSalesCorrectionAccess(client:PoolClient,user:User,companyId:number) {
  if (!user.owner) throw new HttpError(403,"sales_correction_owner","تصحيح كمية المبيعات متاح للمالك فقط.");
  const pages=await directoryEntries(client,user,companyId);
  if (!["company.items","company.sales","company.invoice"].every(key=>{
    const page=pages.find(p=>p.key===key);
    return page?.enabled && page.actionAccess.view;
  })) throw new HttpError(403,"sales_correction_view","يتطلب تصحيح الكمية صلاحية عرض الصنف وفاتورة البيع.");
}

const sourceCols=`s.source_key AS "sourceKey",s.source_kind AS "sourceKind",
  s.document_date::text AS "documentDate",s.invoice_number AS "invoiceNumber",s.line_number AS "lineNumber",
  trim_scale(round(s.original_smallest / NULLIF(s.first_unit_multiplier,0),6))::text AS "originalQuantity",
  trim_scale(c.corrected_quantity)::text AS "correctedQuantity",coalesce(c.revision,0) AS revision,
  c.reason,s.unit_name AS "unitName",s.can_correct AS "canCorrect",s.staged_unit AS "originalRecordedUnit",
  trim_scale(s.staged_quantity)::text AS "originalRecordedQuantity"`;

export const salesCorrectionSourcesSql=`SELECT s.*, c.corrected_quantity,c.revision,c.reason
 FROM (
   SELECT * FROM sales_quantity_correction_posted_sources WHERE company_id=$1 AND item_id=$2
   UNION ALL
   SELECT * FROM sales_quantity_correction_staged_sources WHERE company_id=$1 AND item_id=$2
 ) s LEFT JOIN sales_quantity_corrections c ON c.company_id=s.company_id
   AND c.item_id=s.item_id AND c.source_key=s.source_key`;

export async function listSalesQuantityCorrections(client:PoolClient,companyId:number,itemId:number,
  input:z.infer<typeof salesCorrectionListSchema>) {
  const rows=(await client.query(
    `SELECT ${sourceCols} FROM (${salesCorrectionSourcesSql}) s
     CROSS JOIN LATERAL (SELECT s.corrected_quantity,s.revision,s.reason) c
     ORDER BY s.document_date DESC,s.source_kind,s.invoice_number DESC,
       s.source_id DESC,s.line_number DESC,s.source_key
     LIMIT $3 OFFSET $4`,[companyId,itemId,input.pageSize+1,(input.page-1)*input.pageSize],
  )).rows;
  return {items:rows.slice(0,input.pageSize),page:input.page,pageSize:input.pageSize,hasMore:rows.length>input.pageSize};
}

export async function patchSalesQuantityCorrection(client:PoolClient,user:User,companyId:number,itemId:number,
  input:z.infer<typeof salesCorrectionPatchSchema>) {
  // Fail closed: look up the exact immutable posted line, or an exactly
  // reconstructed staged source line for this item. No invoice/stock write.
  const source=(await client.query(`${salesCorrectionSourcesSql} WHERE s.source_key=$3`,
    [companyId,itemId,input.sourceKey])).rows[0];
  if (!source) throw new HttpError(404,"sales_correction_source_missing","سطر المبيعات المحدد غير موجود على هذا الصنف.");
  if (!source.can_correct) throw new HttpError(409,"sales_correction_unit_unknown","تعذر تثبيت كمية السطر التاريخية أو معاملها؛ لا تُسجّل كمية تخمينية.");
  if ((source.revision??0)!==input.expectedRevision)
    throw new HttpError(409,"sales_correction_conflict","تغيّر التصحيح؛ حدّث السطر وراجع قيمته قبل الحفظ.");
  if (input.expectedRevision===0&&input.correctedQuantity===null)
    return getSalesCorrectionRow(client,companyId,itemId,input.sourceKey);
  const saved=await client.query(
    `INSERT INTO sales_quantity_corrections AS c
     (company_id,item_id,source_key,invoice_line_id,source_system,source_id,line_number,
      source_origin,source_document_date,source_staged_unit,source_staged_quantity,
      original_smallest,first_unit_multiplier,corrected_quantity,reason,changed_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT(company_id,source_key) DO UPDATE SET
       source_origin=EXCLUDED.source_origin,source_document_date=EXCLUDED.source_document_date,
       source_staged_unit=EXCLUDED.source_staged_unit,source_staged_quantity=EXCLUDED.source_staged_quantity,
       original_smallest=EXCLUDED.original_smallest,first_unit_multiplier=EXCLUDED.first_unit_multiplier,
       corrected_quantity=EXCLUDED.corrected_quantity,reason=EXCLUDED.reason,
       changed_by=EXCLUDED.changed_by,updated_at=clock_timestamp(),revision=c.revision+1
     WHERE c.revision=$17 AND c.item_id=$2 RETURNING revision`,
    [companyId,itemId,input.sourceKey,source.invoice_line_id,source.source_system,source.source_id,source.line_number,
      source.source_kind,source.document_date,source.staged_unit,source.staged_quantity,
      source.original_smallest,source.first_unit_multiplier,input.correctedQuantity,input.reason,user.id,input.expectedRevision],
  );
  if (!saved.rowCount) throw new HttpError(409,"sales_correction_conflict","تغيّر التصحيح؛ حدّث السطر قبل الحفظ.");
  const item=await getSalesCorrectionRow(client,companyId,itemId,input.sourceKey);
  if (!item) throw new HttpError(409,"sales_correction_source_changed","تغيّر سطر المصدر أثناء الحفظ؛ حدّث القائمة.");
  await audit(client,user,"item.field.update","item",itemId,
    {field:"salesQuantityCorrection",sourceKey:input.sourceKey,value:source.corrected_quantity??null,revision:source.revision??0},
    {field:"salesQuantityCorrection",sourceKey:input.sourceKey,value:item.correctedQuantity??null,
      reason:input.reason,revision:saved.rows[0].revision},companyId);
  return item;
}

async function getSalesCorrectionRow(client:PoolClient,companyId:number,itemId:number,sourceKey:string) {
  return (await client.query(`SELECT ${sourceCols} FROM (${salesCorrectionSourcesSql}) s
    CROSS JOIN LATERAL (SELECT s.corrected_quantity,s.revision,s.reason) c
    WHERE s.source_key=$3`,[companyId,itemId,sourceKey])).rows[0]??null;
}
