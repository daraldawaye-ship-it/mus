import { Router } from "express";
import type { Pool } from "pg";
import { actor, handler } from "./http.ts";
import { HttpError } from "./errors.ts";
import { readItems } from "./services/items.ts";
import { directoryEntries } from "./services/pages.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { controlValue } from "./services/control-values.ts";
import { settlementDuePredicate, settlementFollowUpFrom } from "./services/settlement-due.ts";

/** Read-only: monthly counts from the incrementally maintained daily summary;
 * latest count via the item_statistics snapshot pointer, not a history scan. */
export function settlementFollowUpRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/companies/:companyId/settlement-follow-up",
    handler(async (req, res) => {
      const data = await readItems(pool, req, async (client, companyId) => {
        const directory = await directoryEntries(client, actor(req), companyId);
        // This is a dedicated read-only stock-count report. Its *own* page
        // grant is authoritative; do not require unrelated sales, purchase,
        // ledger or stock-movement pages, especially for sales/purchase staff.
        const entry = directory.find(page => page.key === "company.settlement-follow-up");
        if (!entry?.enabled || !entry.actionAccess.view)
          throw new HttpError(403, "forbidden", "لا تملك صلاحية عرض متابعة التسويات.");
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
            showroomQuantity: "COALESCE(stats.stock_showroom, 0)",
            quantityWithoutReturns: "COALESCE(stats.stock_without_returns, 0)",
          },
          "monthlySales:desc,name:asc",
        );
        const dueOnly = req.query.dueOnly === "1";
        if (req.query.dueOnly !== undefined && !["0", "1"].includes(String(req.query.dueOnly)))
          throw new HttpError(400, "invalid_query", "خيار المطلوب جردها غير صالح");
        const params = [companyId, searchPattern(query.q)];
        const where = `i.company_id=$1 AND i.active=true AND (
          i.name ILIKE $2 OR i.code ILIKE $2 OR i.english_name ILIKE $2
          OR i.barcode ILIKE $2 OR i.search_keys ILIKE $2
        )`;
        // Shared report relation: due filtering happens in SQL BEFORE LIMIT/OFFSET.
        // The negative-stock condition is showroom-only, read from the cached
        // statistics projection; negative warehouses/returns do not trigger it.
        const reportFrom = settlementFollowUpFrom("$3");
        const dueWhere = dueOnly ? ` AND ${settlementDuePredicate}` : "";
        const filteredWhere = where + dueWhere;
        const count = await client.query<{ total: number }>(
          `SELECT count(*)::integer AS total ${reportFrom} WHERE ${filteredWhere}`,
          [...params, importance],
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
          showroomQuantity: string;
          quantityWithoutReturns: string;
        }>(
          `SELECT i.id, i.name,
            COALESCE(activity.monthly_sales, 0)::text AS "monthlySales",
            i.purchase_price::text AS "purchasePrice",
            c.code AS "currencyCode",
            i.nearest_expiry_date::text AS "nearestExpiryDate",
            last_count.document_date::text AS "lastAdjustmentDate",
            ROUND(count_limit.raw_limit, 6)::text AS "countLimit",
            COALESCE(stats.has_negative_stock, false) AS "hasNegativeStock",
            COALESCE(stats.stock_showroom, 0)::text AS "showroomQuantity",
            COALESCE(stats.stock_without_returns, 0)::text AS "quantityWithoutReturns"
          ${reportFrom}
          WHERE ${filteredWhere}
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
          ${reportFrom}
          WHERE ${filteredWhere} AND stats.stock_total > 0`,
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
