import { Router } from "express";
import type { Pool } from "pg";
import { actor, handler } from "./http.ts";
import { HttpError } from "./errors.ts";
import { readItems } from "./services/items.ts";
import { directoryEntries } from "./services/pages.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { controlValue } from "./services/control-values.ts";

/** Read-only: monthly counts from the incrementally maintained daily summary;
 * latest count via the item_statistics snapshot pointer, not a history scan. */
export function settlementFollowUpRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/companies/:companyId/settlement-follow-up",
    handler(async (req, res) => {
      const data = await readItems(pool, req, async (client, companyId) => {
        const directory = await directoryEntries(client, actor(req), companyId);
        // A list of item cards must not bypass sales, purchase, or invoice visibility.
        for (const key of ["company.sales", "company.purchases", "company.invoice", "company.stock-balances", "company.stock-movements"]) {
          const entry = directory.find((page) => page.key === key);
          if (!entry?.enabled || !entry.actionAccess.view)
            throw new HttpError(
              403,
              "forbidden",
              "متابعة التسويات تتطلب صلاحيات عرض الأصناف والفواتير والمخزون.",
            );
        }
        const configured = await controlValue(client, companyId, "inventory_count_importance");
        const importance = typeof configured === "number" ? configured : 8;
        const query = listQuery(
          req.query,
          {
            id: "i.id",
            name: "i.name",
            monthlySales: "COALESCE(activity.monthly_sales, 0)",
            purchasePrice: "i.purchase_price",
            nearestExpiryDate: "i.nearest_expiry_date",
            lastAdjustmentDate: "last_count.document_date",
            countLimit: "count_limit.raw_limit",
            hasNegativeStock: "COALESCE(stats.has_negative_stock, false)",
          },
          "monthlySales:desc,name:asc",
        );
        const params = [companyId, searchPattern(query.q)];
        const where = `i.company_id=$1 AND i.active=true AND (
          i.name ILIKE $2 OR i.code ILIKE $2 OR i.english_name ILIKE $2
          OR i.barcode ILIKE $2 OR i.search_keys ILIKE $2
        )`;
        const count = await client.query<{ total: number }>(
          `SELECT count(*)::integer AS total FROM items i WHERE ${where}`,
          params,
        );
        const result = await client.query<{
          id: number;
          name: string;
          monthlySales: string;
          purchasePrice: string;
          currencyCode: string;
          nearestExpiryDate: string | null;
          lastAdjustmentDate: string | null;
          countLimit: string;
          hasNegativeStock: boolean;
        }>(
          `SELECT i.id, i.name,
            COALESCE(activity.monthly_sales, 0)::text AS "monthlySales",
            i.purchase_price::text AS "purchasePrice",
            c.code AS "currencyCode",
            i.nearest_expiry_date::text AS "nearestExpiryDate",
            last_count.document_date::text AS "lastAdjustmentDate",
            ROUND(count_limit.raw_limit, 6)::text AS "countLimit",
            COALESCE(stats.has_negative_stock, false) AS "hasNegativeStock"
          FROM items i
          JOIN company_currencies c
            ON c.company_id=i.company_id AND c.id=i.currency_id
          LEFT JOIN item_statistics stats
            ON stats.company_id=i.company_id AND stats.item_id=i.id
          LEFT JOIN stock_operations last_count
            ON last_count.company_id=stats.company_id AND last_count.id=stats.last_adjustment_operation_id AND last_count.kind='adjustment'
          LEFT JOIN LATERAL (
            SELECT sum(d.sale_invoices - d.sale_return_invoices) AS monthly_sales
            FROM item_daily_activity d
            WHERE d.company_id=i.company_id AND d.item_id=i.id
              AND d.document_date BETWEEN
                ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date - interval '1 month' + interval '1 day')::date
                AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
          ) activity ON true
          -- Net returns can make monthly sales negative; zero is the safe
          -- minimum only for the divisor, while the displayed sales stay exact.
          LEFT JOIN LATERAL (
            SELECT ($3::numeric * 30) / (GREATEST(COALESCE(activity.monthly_sales, 0), 0) + 5) AS raw_limit
          ) count_limit ON true
          WHERE ${where}
          ORDER BY ${query.order}
          LIMIT $4 OFFSET $5`,
          [...params, importance, query.pageSize, query.offset],
        );
        // Compute across all matching active items, independent of the visible page.
        // A stock_total > 0 is required: out-of-stock/negative items must not
        // contribute to the monthly count workload, even if they have sales.
        // 30 / ((importance * 30) / (sales + 5)) = (sales + 5) / importance.
        const summary = await client.query<{
          stocktakeFrequencyTotal: string;
          stockedItemsCount: number;
        }>(
          `SELECT
            COALESCE(ROUND(SUM(
              (GREATEST(COALESCE(activity.monthly_sales, 0), 0) + 5) / $3::numeric
            ), 6), 0)::text AS "stocktakeFrequencyTotal",
            COUNT(*)::integer AS "stockedItemsCount"
          FROM items i
          JOIN item_statistics stock
            ON stock.company_id=i.company_id AND stock.item_id=i.id
            AND stock.stock_total > 0
          LEFT JOIN LATERAL (
            SELECT SUM(d.sale_invoices - d.sale_return_invoices) AS monthly_sales
            FROM item_daily_activity d
            WHERE d.company_id=i.company_id AND d.item_id=i.id
              AND d.document_date BETWEEN
                ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date - interval '1 month' + interval '1 day')::date
                AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
          ) activity ON true
          WHERE ${where}`,
          [...params, importance],
        );
        return {
          stocktakeFrequencyTotal: summary.rows[0]?.stocktakeFrequencyTotal ?? "0",
          stockedItemsCount: summary.rows[0]?.stockedItemsCount ?? 0,
          items: result.rows,
          total: count.rows[0]?.total ?? 0,
          page: query.page,
          pageSize: query.pageSize,
        };
      });
      res.json(data);
    }),
  );
  return router;
}
