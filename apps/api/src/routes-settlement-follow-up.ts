import { Router } from "express";
import type { Pool } from "pg";
import { actor, handler } from "./http.ts";
import { HttpError } from "./errors.ts";
import { readItems } from "./services/items.ts";
import { directoryEntries } from "./services/pages.ts";
import { listQuery, searchPattern } from "./services/lists.ts";

/** Read-only list: item master fields + posted invoice counts from the daily summary. */
export function settlementFollowUpRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/companies/:companyId/settlement-follow-up",
    handler(async (req, res) => {
      const data = await readItems(pool, req, async (client, companyId) => {
        const directory = await directoryEntries(client, actor(req), companyId);
        // A list of item cards must not bypass sales, purchase, or invoice visibility.
        for (const key of ["company.sales", "company.purchases", "company.invoice"]) {
          const entry = directory.find((page) => page.key === key);
          if (!entry?.enabled || !entry.actionAccess.view)
            throw new HttpError(
              403,
              "forbidden",
              "عرض مرات البيع يتطلب صلاحية عرض الفواتير والمبيعات والمشتريات.",
            );
        }
        const query = listQuery(
          req.query,
          {
            id: "i.id",
            name: "i.name",
            monthlySales: "COALESCE(activity.monthly_sales, 0)",
            purchasePrice: "i.purchase_price",
            nearestExpiryDate: "i.nearest_expiry_date",
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
        }>(
          `SELECT i.id, i.name,
            COALESCE(activity.monthly_sales, 0)::text AS "monthlySales",
            i.purchase_price::text AS "purchasePrice",
            c.code AS "currencyCode",
            i.nearest_expiry_date::text AS "nearestExpiryDate"
          FROM items i
          JOIN company_currencies c
            ON c.company_id=i.company_id AND c.id=i.currency_id
          LEFT JOIN LATERAL (
            SELECT sum(d.sale_invoices - d.sale_return_invoices) AS monthly_sales
            FROM item_daily_activity d
            WHERE d.company_id=i.company_id AND d.item_id=i.id
              AND d.document_date BETWEEN
                ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date - interval '1 month' + interval '1 day')::date
                AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
          ) activity ON true
          WHERE ${where}
          ORDER BY ${query.order}
          LIMIT $3 OFFSET $4`,
          [...params, query.pageSize, query.offset],
        );
        return {
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
