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
import { audit } from "./services/audit.ts";

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


  // Distinct shared/main medical names, not the first page of child records.
  router.get("/companies/:companyId/doctor-sales-movements/main-names",handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const input=parse(z.object({
      q:z.string().trim().max(120).optional().default(""),
    }).strict(),req.query);
    const result=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user=await currentActor(client,actor(req),false);
      await companyAccess(client,user,companyId,"commerce.view");
      const page=(await directoryEntries(client,user,companyId))
        .find(entry=>entry.key==="company.doctor-sales-movements");
      if(!page?.enabled||!page.actionAccess.view)
        throw new HttpError(403,"forbidden","ليست لديك صلاحية عرض أسماء التقرير");
      const names=await client.query(
        "SELECT COALESCE(NULLIF(btrim(d.shared_name),''),d.name) AS name,"+
        " array_agg(DISTINCT d.kind) AS kinds FROM doctors d"+
        " WHERE d.company_id=$1 AND d.kind IN ('doctor','nurse')"+
        " AND COALESCE(NULLIF(btrim(d.shared_name),''),d.name) ILIKE $2 ESCAPE '\\'"+
        " GROUP BY 1 ORDER BY 1 LIMIT 40",
        [companyId,searchPattern(input.q)]);
      return {items:names.rows};
    });
    res.json(result);
  }));

  // An exact main-name choice covers all children. Totals are filtered before paging.
  router.get("/companies/:companyId/doctor-sales-movements",handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const input=parse(z.object({
      dateFrom:documentDateSchema,
      dateTo:documentDateSchema,
      q:z.string().trim().max(120).optional().default(""),
      mainName:z.string().trim().max(240).optional().default(""),
      page:z.coerce.number().int().min(1).max(100000).optional().default(1),
      pageSize:z.coerce.number().int().min(1).max(100).optional().default(50),
    }).strict(),req.query);
    if(input.dateFrom>input.dateTo)
      throw new HttpError(400,"invalid_date_range","تاريخ البداية يجب ألا يتجاوز تاريخ النهاية");
    const response=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user=await currentActor(client,actor(req),false);
      await companyAccess(client,user,companyId,"commerce.view");
      const page=(await directoryEntries(client,user,companyId))
        .find(entry=>entry.key==="company.doctor-sales-movements");
      if(!page?.enabled||!page.actionAccess.view)
        throw new HttpError(403,"forbidden","ليست لديك صلاحية عرض حركة مبيعات الأطباء والممرضين");
      const day=await client.query<{today:string;minDate:string}>(
        "SELECT (now() AT TIME ZONE 'Asia/Aden')::date::text AS today,"+
        " ((now() AT TIME ZONE 'Asia/Aden')::date - 9)::text AS \"minDate\"");
      const {today,minDate}=day.rows[0]!;
      if(input.dateFrom<minDate||input.dateTo>today)
        throw new HttpError(400,"invalid_date_range","يُسمح بالتقرير من آخر 10 أيام وحتى اليوم فقط");

      const where=[
        " FROM invoices i",
        " JOIN doctors d ON d.company_id=i.company_id AND d.id=i.doctor_id",
        " LEFT JOIN doctor_sales_accounted_invoices mark ON mark.company_id=i.company_id AND mark.invoice_id=i.id",
        " LEFT JOIN legacy_sales_sign_repairs fix ON fix.company_id=i.company_id AND fix.invoice_id=i.id",
        " WHERE i.company_id=$1 AND i.kind='sale' AND i.posted=true",
        " AND d.kind IN ('doctor','nurse')",
        " AND i.document_date BETWEEN $2::date AND $3::date",
        " AND ($4::text='' OR COALESCE(NULLIF(btrim(d.shared_name),''),d.name)=$4)",
        " AND COALESCE(NULLIF(btrim(d.shared_name),''),d.name) ILIKE $5 ESCAPE '\\'",
      ].join("");
      const params=[companyId,input.dateFrom,input.dateTo,input.mainName,searchPattern(input.q)];
      const totals=await client.query(
        "SELECT i.currency_code AS \"currencyCode\", count(*)::integer AS count,"+
        " SUM(COALESCE(fix.corrected_total::numeric,i.total))::text AS total,"+
        " COUNT(*) FILTER (WHERE mark.invoice_id IS NOT NULL)::integer AS \"accountedCount\","+
        " COUNT(*) FILTER (WHERE mark.invoice_id IS NULL)::integer AS \"unaccountedCount\","+
        " COALESCE(SUM(COALESCE(fix.corrected_total::numeric,i.total))"+
        " FILTER (WHERE mark.invoice_id IS NOT NULL),0)::text AS \"accountedTotal\","+
        " COALESCE(SUM(COALESCE(fix.corrected_total::numeric,i.total))"+
        " FILTER (WHERE mark.invoice_id IS NULL),0)::text AS \"unaccountedTotal\"" +
        where+" GROUP BY i.currency_code ORDER BY i.currency_code",params);
      const rows=await client.query(
        "SELECT i.id,i.number,i.document_date::text AS \"documentDate\","+
        " i.created_at AS \"createdAt\", i.counterparty_account_name AS \"accountName\","+
        " i.description AS notes,i.doctor_id AS \"doctorId\","+
        " COALESCE(NULLIF(btrim(d.shared_name),''),d.name) AS \"doctorName\","+
        " d.kind AS \"doctorKind\",i.currency_code AS \"currencyCode\","+
        " (mark.invoice_id IS NOT NULL) AS accounted,"+
        " COALESCE(fix.corrected_total::numeric,i.total)::text AS total"+
        where+" ORDER BY i.created_at DESC,i.id DESC LIMIT $6 OFFSET $7",
        [...params,input.pageSize,(input.page-1)*input.pageSize]);
      return {
        items:rows.rows,
        total:totals.rows.reduce((sum,row)=>sum+Number(row.count),0),
        totals:totals.rows.map(row=>({
          currencyCode:row.currencyCode,total:row.total,count:row.count,
          accountedCount:row.accountedCount,unaccountedCount:row.unaccountedCount,
          accountedTotal:row.accountedTotal,unaccountedTotal:row.unaccountedTotal,
        })),
        page:input.page,pageSize:input.pageSize,
      };
    });
    res.json(response);
  }));

  // Explicit operator confirmation. Mark the clicked sale and all earlier
  // already-posted sales of the same current primary name, across child cards
  // and all dates (the 10-day limit applies only to the viewing report).
  router.post("/companies/:companyId/doctor-sales-movements/:invoiceId/accounted",
    handler(async (req,res) => {
      const companyId=id(req.params.companyId), invoiceId=id(req.params.invoiceId);
      const result=await transaction(pool,async client=>{
        const user=await currentActor(client,actor(req),false);
        await companyAccess(client,user,companyId,"commerce.manage");
        const page=(await directoryEntries(client,user,companyId))
          .find(entry=>entry.key==="company.doctor-sales-movements");
        if(!page?.enabled||!page.actionAccess.edit)
          throw new HttpError(403,"forbidden","لا تملك صلاحية تأشير الفواتير كمحاسبة");
        const target=await client.query<{
          mainName:string; createdAt:Date; kind:string;
        }>(
          "SELECT COALESCE(NULLIF(btrim(d.shared_name),''),d.name) AS \"mainName\","+
          " i.created_at AS \"createdAt\",d.kind"+
          " FROM invoices i JOIN doctors d"+
          " ON d.company_id=i.company_id AND d.id=i.doctor_id"+
          " WHERE i.company_id=$1 AND i.id=$2"+
          " AND i.kind='sale' AND i.posted=true"+
          " AND d.kind IN ('doctor','nurse') FOR SHARE OF i,d",
          [companyId,invoiceId]);
        const clicked=target.rows[0];
        if(!clicked)
          throw new HttpError(404,"not_found","لم تُعثر على فاتورة طبيب أو ممرض مؤهلة");
        const added=await client.query<{invoiceId:number}>(
          "INSERT INTO doctor_sales_accounted_invoices"+
          " (company_id,invoice_id,main_name,cutoff_invoice_id,marked_by)"+
          " SELECT i.company_id,i.id,$3::text,$2,$4 FROM invoices i"+
          " JOIN doctors d ON d.company_id=i.company_id AND d.id=i.doctor_id"+
          " JOIN invoices cutoff ON cutoff.company_id=i.company_id AND cutoff.id=$2"+
          " WHERE i.company_id=$1 AND i.kind='sale' AND i.posted=true"+
          " AND d.kind=$5"+
          " AND COALESCE(NULLIF(btrim(d.shared_name),''),d.name)=$3::text"+
          " AND (i.created_at,i.id)<=(cutoff.created_at,cutoff.id)"+
          " ON CONFLICT(company_id,invoice_id) DO NOTHING"+
          " RETURNING invoice_id AS \"invoiceId\"",
          [companyId,invoiceId,clicked.mainName,user.id,clicked.kind]);
        await audit(client,user,"doctor.sales.accounted","invoice",invoiceId,null,{
          mainName:clicked.mainName,
          kind:clicked.kind,
          cutoffInvoiceId:invoiceId,
          cutoffCreatedAt:clicked.createdAt.toISOString(),
          newlyMarked:added.rows.length,
          effect:"classification_only_no_journal_or_stock_change",
        },companyId);
        return {
          mainName:clicked.mainName,
          newlyMarked:added.rows.length,
          cutoffInvoiceId:invoiceId,
        };
      });
      res.json({result});
    }));
  return router;
}
