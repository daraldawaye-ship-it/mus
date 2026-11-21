import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { documentDateSchema } from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { deny, HttpError } from "./errors.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { currentPurchase } from "./services/current-purchase.ts";

const filters = z.object({
  dateFrom: documentDateSchema, dateTo: documentDateSchema,
  includeRaw: z.enum(["true", "false"]).default("false"),
}).strict();
const counts = (column: string) => `
  count(*) FILTER (WHERE kind='sale' AND ${column}>0)::int AS sales,
  count(*) FILTER (WHERE kind='sale' AND ${column}<0)::int AS "salesReturns",
  count(*) FILTER (WHERE kind='purchase' AND ${column}>0)::int AS purchases,
  count(*) FILTER (WHERE kind='purchase' AND ${column}<0)::int AS "purchaseReturns"`;
const countJson = (alias: string) => `jsonb_build_object(
  'sales',coalesce(${alias}.sales,0),'salesReturns',coalesce(${alias}."salesReturns",0),
  'purchases',coalesce(${alias}.purchases,0),'purchaseReturns',coalesce(${alias}."purchaseReturns",0))`;
export const dailyInvoiceLinesSql = `WITH base AS (
  SELECT i.company_id,i.id,i.kind,i.document_date AS day
  FROM invoices i
  WHERE i.company_id=$1 AND i.posted AND i.kind IN ('sale','purchase')
    AND i.document_date BETWEEN $2::date AND $3::date
), effective_invoices AS (
  SELECT b.company_id,b.id,b.kind,b.day FROM base b WHERE b.kind='sale'
  UNION ALL
  SELECT i.company_id,i.id,i.kind,i.document_date
  FROM base b JOIN invoices i ON i.company_id=b.company_id AND i.id=b.id
  WHERE b.kind='purchase' AND ${currentPurchase}
    AND NOT EXISTS (SELECT 1 FROM purchase_correction_dates pd WHERE pd.company_id=i.company_id AND pd.invoice_id=i.id)
  UNION ALL
  SELECT i.company_id,i.id,i.kind,pd.invoice_date
  FROM purchase_correction_dates pd
  JOIN invoices i ON i.company_id=pd.company_id AND i.id=pd.invoice_id
  WHERE pd.company_id=$1 AND pd.invoice_date BETWEEN $2::date AND $3::date
    AND i.posted AND i.kind='purchase' AND ${currentPurchase}
), effective_lines AS (
  SELECT i.day,i.kind,COALESCE(repaired.quantity,l.smallest_quantity) AS q
  FROM effective_invoices i JOIN invoice_lines l ON l.company_id=i.company_id AND l.invoice_id=i.id
  LEFT JOIN legacy_sales_sign_repairs fix ON i.kind='sale' AND fix.company_id=i.company_id AND fix.invoice_id=i.id
  LEFT JOIN LATERAL (
    SELECT (snap.value->>'smallestQuantity')::numeric AS quantity FROM jsonb_array_elements(fix.line_snapshots) AS snap(value)
    WHERE (snap.value->>'lineNumber')::integer=l.line_number LIMIT 1
  ) repaired ON TRUE
), posted AS (
  SELECT day,${counts("q")} FROM effective_lines GROUP BY day
), raw AS (
  SELECT b.day,${counts("l.smallest_quantity")}
  FROM base b JOIN invoice_lines l ON l.company_id=b.company_id AND l.invoice_id=b.id
  WHERE $4::boolean GROUP BY b.day
), staged AS (
  SELECT document_date AS day,sum(sale_lines)::int AS sales,sum(sale_return_lines)::int AS "salesReturns",
    sum(purchase_lines)::int AS purchases,sum(purchase_return_lines)::int AS "purchaseReturns"
  FROM staged_item_daily_activity_cache
  WHERE company_id=$1 AND document_date BETWEEN $2::date AND $3::date GROUP BY document_date
)
SELECT d.day::date::text AS date,${countJson("p")} AS posted,${countJson("s")} AS staged,
  CASE WHEN $4::boolean THEN ${countJson("r")} END AS "rawPosted"
FROM generate_series($2::date,$3::date,'1 day'::interval) AS d(day)
LEFT JOIN posted p ON p.day=d.day::date LEFT JOIN raw r ON r.day=d.day::date LEFT JOIN staged s ON s.day=d.day::date
ORDER BY d.day DESC`;

export function dailyInvoiceLineRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/companies/:companyId/daily-invoice-line-counts", handler(async (req, res) => {
    const session = actor(req);
    if (!session.owner) deny();
    const companyId = id(req.params.companyId);
    const {dateFrom, dateTo, includeRaw} = parse(filters, req.query);
    const duration = (Date.parse(dateTo+"T00:00:00Z") - Date.parse(dateFrom+"T00:00:00Z")) / 86400000;
    if (!Number.isFinite(duration) || duration < 0 || duration > 365)
      throw new HttpError(400,"invalid_date_range","حدد فترة صحيحة لا تتجاوز 366 يومًا");
    const rows = await transaction(pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user = await currentActor(client, session, false);
      if (!user.owner) deny();
      await companyAccess(client, user, companyId, "commerce.view");
      return (await client.query(dailyInvoiceLinesSql, [companyId,dateFrom,dateTo,includeRaw==="true"])).rows
        .map(({ rawPosted, ...row }) => rawPosted === null ? row : {...row, rawPosted});
    });
    res.set("Cache-Control","private, no-store");
    res.json({ dateFrom,dateTo,rows });
  }));
  return router;
}
