import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { documentDateSchema } from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { HttpError } from "./errors.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { directoryEntries } from "./services/pages.ts";

/**
 * Time-of-day sales report. Day = posted invoice document date, while hour
 * comes from the actual Aden-local creation timestamp. Historical imports
 * whose creation day differs from the invoice day have an unknown hour:
 * never attribute an import's execution hour to the original sale.
 * Signed invoice-line amounts separate returns even on mixed invoices.
 */
const filters = z.object({
  dateFrom: documentDateSchema,
  dateTo: documentDateSchema,
  payment: z.enum(["all", "cash", "credit"]).optional().default("all"),
}).strict();

export function salesTimeReportRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/companies/:companyId/sales-time-report", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const input = parse(filters, req.query);
    const fromMillis = Date.parse(input.dateFrom + "T00:00:00Z");
    const toMillis = Date.parse(input.dateTo + "T00:00:00Z");
    if (!Number.isFinite(fromMillis) || !Number.isFinite(toMillis) ||
        fromMillis > toMillis)
      throw new HttpError(400, "invalid_date_range", "تاريخ البداية يجب ألا يتجاوز النهاية");
    if ((toMillis - fromMillis) / 86400000 > 365)
      throw new HttpError(400, "date_range_too_large", "أقصى فترة للتقرير 366 يومًا");

    const report = await transaction(pool, async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user = await currentActor(client, actor(req), false);
      await companyAccess(client, user, companyId, "commerce.view");
      const page = (await directoryEntries(client, user, companyId))
        .find((entry) => entry.key === "company.sales-time-report");
      if (!page?.enabled || !page.actionAccess.view)
        throw new HttpError(403, "forbidden", "ليست لديك صلاحية تقرير مبيعات الأوقات");

      const baseCurrency = await client.query(
        "SELECT c.code FROM finance_settings s JOIN company_currencies c ON c.company_id=s.company_id AND c.id=s.base_currency_id WHERE s.company_id=$1",
        [companyId],
      );
      const activity = await client.query(
        `WITH sales_lines AS (
          SELECT i.id AS invoice_id, i.document_date AS day,
            CASE WHEN (i.created_at AT TIME ZONE 'Asia/Aden')::date = i.document_date
              THEN EXTRACT(HOUR FROM i.created_at AT TIME ZONE 'Asia/Aden')::integer
              ELSE NULL::integer END AS hour,
            i.base_currency_code AS currency_code,
            CASE WHEN fix.invoice_id IS NULL THEN il.base_total
              ELSE -il.base_total END AS amount
          FROM invoices i
          JOIN invoice_lines il ON il.company_id=i.company_id AND il.invoice_id=i.id
          LEFT JOIN accounts a ON a.company_id=i.company_id
            AND a.id=i.counterparty_account_id
          LEFT JOIN legacy_sales_sign_repairs fix ON fix.company_id=i.company_id
            AND fix.invoice_id=i.id
          WHERE i.company_id=$1 AND i.kind='sale' AND i.posted=true
            AND i.document_date BETWEEN $2::date AND $3::date
            AND ($4::text='all' OR
              ($4::text='cash' AND COALESCE(a.cash_or_bank,false)) OR
              ($4::text='credit' AND NOT COALESCE(a.cash_or_bank,false)))
        )
        SELECT day::text AS "date",hour,
          currency_code AS "currencyCode",
          GROUPING(day,hour)::integer AS "level",
          count(DISTINCT invoice_id)::integer AS "invoiceCount",
          count(DISTINCT invoice_id) FILTER (WHERE amount < 0)::integer AS "returnInvoiceCount",
          COALESCE(sum(amount) FILTER (WHERE amount > 0),0)::text AS "sales",
          COALESCE(-sum(amount) FILTER (WHERE amount < 0),0)::text AS "returns",
          COALESCE(sum(amount),0)::text AS "net"
        FROM sales_lines
        GROUP BY GROUPING SETS (
          (day,hour,currency_code),
          (day,currency_code),
          (currency_code)
        )
        ORDER BY "level" DESC,day DESC,hour ASC NULLS LAST,currency_code`,
        [companyId, input.dateFrom, input.dateTo, input.payment],
      );
      return {
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        payment: input.payment,
        baseCurrencyCode: String(baseCurrency.rows[0]?.code ?? ""),
        rows: activity.rows,
      };
    });
    res.json({ report });
  }));
  return router;
}
