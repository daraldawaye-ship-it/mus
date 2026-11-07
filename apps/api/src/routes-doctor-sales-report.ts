import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { documentDateSchema } from "../../../packages/contracts/src/index.ts";
import { handler, actor, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { HttpError } from "./errors.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { directoryEntries } from "./services/pages.ts";
import { searchPattern } from "./services/lists.ts";
import { doctorSalesReportSql } from "./services/doctor-sales-report.ts";

const filters = z.object({
  dateFrom: documentDateSchema,
  dateTo: documentDateSchema,
  q: z.string().trim().max(120).optional().default(""),
  medicalOnly: z.enum(["true","false"]).optional().default("false"),
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
}).strict();

export function doctorSalesReportRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/companies/:companyId/doctor-sales-report", handler(async (req,res) => {
    const companyId = id(req.params.companyId);
    const input = parse(filters, req.query);
    if (input.dateFrom > input.dateTo)
      throw new HttpError(400,"invalid_date_range","تاريخ البداية يجب ألا يتجاوز تاريخ النهاية");
    const result = await transaction(pool,async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user = await currentActor(client,actor(req),false);
      await companyAccess(client,user,companyId,"commerce.view");
      const page = (await directoryEntries(client,user,companyId))
        .find(entry => entry.key === "company.doctor-sales-report");
      if (!page?.enabled || !page.actionAccess.view)
        throw new HttpError(403,"forbidden","ليست لديك صلاحية عرض تقرير مبيعات الأطباء والجهات");
      const rows = await client.query(doctorSalesReportSql,[
        companyId,input.dateFrom,input.dateTo,searchPattern(input.q),
        input.pageSize,(input.page-1)*input.pageSize,input.medicalOnly==="true",
      ]);
      const first=rows.rows[0];
      return {
        dateFrom:input.dateFrom,dateTo:input.dateTo,
        page:input.page,pageSize:input.pageSize,
        total:first?.totalDoctors ?? 0,
        totalBase:first?.periodBaseTotal ?? "0",
        totalInvoices:first?.periodInvoiceCount ?? 0,
        totalReturns:first?.periodReturnCount ?? 0,
        baseCurrencyCode:first?.baseCurrencyCode ?? null,
        items:rows.rows.map(({totalDoctors,periodBaseTotal,periodInvoiceCount,periodReturnCount,...row})=>row),
      };
    });
    res.json({report:result});
  }));

  // Posted sale invoices classified as doctor/nurse, grouped for display and
  // search by the current shared/main doctor name (including all child cards).
  router.get("/companies/:companyId/doctor-sales-movements", handler(async (req,res) => {
    const companyId = id(req.params.companyId);
    const input = parse(z.object({
      dateFrom: documentDateSchema,
      dateTo: documentDateSchema,
      q: z.string().trim().max(120).optional().default(""),
      page: z.coerce.number().int().min(1).max(100000).optional().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
    }).strict(), req.query);
    if (input.dateFrom > input.dateTo)
      throw new HttpError(400, "invalid_date_range", "تاريخ البداية يجب ألا يتجاوز تاريخ النهاية");
    const response = await transaction(pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user = await currentActor(client, actor(req), false);
      await companyAccess(client, user, companyId, "commerce.view");
      const page = (await directoryEntries(client,user,companyId))
        .find(entry => entry.key === "company.doctor-sales-movements");
      if (!page?.enabled || !page.actionAccess.view)
        throw new HttpError(403, "forbidden", "ليست لديك صلاحية عرض حركة مبيعات الأطباء والممرضين");

      const where = `FROM invoices i
        JOIN doctors d ON d.company_id=i.company_id AND d.id=i.doctor_id
        LEFT JOIN legacy_sales_sign_repairs fix
          ON fix.company_id=i.company_id AND fix.invoice_id=i.id
        WHERE i.company_id=$1 AND i.kind='sale' AND i.posted=true
          AND d.kind IN ('doctor','nurse')
          AND i.document_date BETWEEN $2::date AND $3::date
          AND COALESCE(NULLIF(btrim(d.shared_name),''),d.name) ILIKE $4 ESCAPE '\\'`;
      const params = [companyId,input.dateFrom,input.dateTo,searchPattern(input.q)];
      const count = await client.query<{total:number}>(
        `SELECT count(*)::integer AS total ${where}`, params);
      const rows = await client.query(
        `SELECT i.id,i.number,i.document_date::text AS "documentDate",
          i.created_at AS "createdAt",
          i.counterparty_account_name AS "accountName",
          i.description AS notes,
          i.doctor_id AS "doctorId",
          COALESCE(NULLIF(btrim(d.shared_name),''),d.name) AS "doctorName",
          d.kind AS "doctorKind",
          i.currency_code AS "currencyCode",
          COALESCE(fix.corrected_total::numeric,i.total)::text AS total
        ${where}
        ORDER BY i.created_at DESC,i.id DESC LIMIT $5 OFFSET $6`,
        [...params,input.pageSize,(input.page-1)*input.pageSize]);
      return {items:rows.rows,total:count.rows[0]?.total??0,
        page:input.page,pageSize:input.pageSize};
    });
    res.json(response);
  }));
  return router;
}
