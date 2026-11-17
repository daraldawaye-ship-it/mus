import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { actor, handler, parse } from "./http.ts";
import { readItems } from "./services/items.ts";
import { directoryEntries } from "./services/pages.ts";
import { HttpError } from "./errors.ts";
import { searchPattern } from "./services/lists.ts";
import { assertItemSaleRankingsReady } from "./services/item-sale-ranking.ts";
import { effectiveTemplate } from "./services/notifications.ts";

const querySchema = z.object({
  q: z.string().trim().max(120).default(""),
  itemId: z.coerce.number().int().positive().optional(),
  status: z.enum(["all", "active", "archived"]).default("all"),
  level: z.enum(["all", "low", "above"]).default("all"),
  sortBy: z.enum(["urgency", "name", "stock", "sold", "threshold", "difference"]).default("urgency"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(20).max(100).default(50),
}).strip();

/** Read-only report. Uses the exact notification threshold in smallest units.
 * A configured zero is active; stock in returns locations is excluded.
 */
export function itemOrderLevelsRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/companies/:companyId/item-order-levels", handler(async (req, res) => {
    const options = parse(querySchema, req.query);
    const data = await readItems(pool, req, async (client, companyId) => {
      const directory = await directoryEntries(client, actor(req), companyId);
      const allowed = (key: string) => {
        const entry = directory.find(page => page.key === key);
        return !!entry?.enabled && !!entry.actionAccess.view;
      };
      if (!["company.item-order-levels", "company.items",
            "company.stock-balances", "company.stock-movements",
            "company.item-statistics-report"].every(allowed))
        throw new HttpError(403, "forbidden",
          "تتطلب متابعة حدود الطلب صلاحيات الأصناف والمبيعات والمخزون");
      await assertItemSaleRankingsReady(client);
      const asOf = String((await client.query(
        "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today"
      )).rows[0].today);
      const summary = (await client.query<{
        activeConfigured: number; lowActive: number; aboveActive: number;
        archivedConfigured: number; suppressedLow: number; activeIncidents: number;
      }>(
        `WITH levels AS (
          SELECT i.id,i.active,
            COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0)
              <= i.order_alert_quantity*i.factor2::numeric*i.factor3::numeric AS low,
            incident.active AS incident_active,incident.legacy_suppressed
          FROM items i
          LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id
          LEFT JOIN item_order_notification_incidents incident
            ON incident.company_id=i.company_id AND incident.item_id=i.id
          WHERE i.company_id=$1 AND i.order_alert_quantity IS NOT NULL
        )
        SELECT COUNT(*) FILTER(WHERE active)::integer AS "activeConfigured",
          COUNT(*) FILTER(WHERE active AND low)::integer AS "lowActive",
          COUNT(*) FILTER(WHERE active AND NOT low)::integer AS "aboveActive",
          COUNT(*) FILTER(WHERE NOT active)::integer AS "archivedConfigured",
          COUNT(*) FILTER(WHERE active AND low AND incident_active AND legacy_suppressed)::integer AS "suppressedLow",
          COUNT(*) FILTER(WHERE active AND low AND incident_active)::integer AS "activeIncidents"
        FROM levels`,
        [companyId],
      )).rows[0];
      const params = [
        companyId, asOf, options.q ? searchPattern(options.q, true) : "",
        options.status, options.level, options.itemId ?? null,
        options.pageSize, (options.page - 1) * options.pageSize,
      ];
      const orderBy: Record<typeof options.sortBy, string> = {
        urgency: "f.active DESC,f.below_limit DESC,f.difference_unit1 ASC,f.name ASC",
        name: "f.name",
        stock: "f.available_unit1",
        sold: "f.sale_quantity_month",
        threshold: "f.order_alert_quantity",
        difference: "f.difference_unit1",
      };
      const order = options.sortBy === "urgency"
        ? orderBy.urgency
        : orderBy[options.sortBy] + (options.sortDir === "desc" ? " DESC" : " ASC") +
          ",f.code ASC,f.id ASC";
      const result = await client.query(
        `WITH candidates AS MATERIALIZED (
           SELECT i.id,i.code,i.name,i.active,
             i.order_alert_quantity::text AS order_alert_quantity,
             ROUND((COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0))
               / GREATEST(i.factor2::numeric*i.factor3::numeric,1),4) AS available_unit1,
             ROUND((COALESCE(sale_rank.net_sale_quantity,0)
               + COALESCE(staged_rank.net_sale_quantity,0)
               + COALESCE(planning_fix.month_delta,0))
               / GREATEST(i.factor2::numeric*i.factor3::numeric,1),4) AS sale_quantity_month,
             ROUND((COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0))
               / GREATEST(i.factor2::numeric*i.factor3::numeric,1)
               - i.order_alert_quantity,4) AS difference_unit1,
             (COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0)
               <= i.order_alert_quantity*i.factor2::numeric*i.factor3::numeric) AS below_limit
           FROM items i
           LEFT JOIN item_statistics s
             ON s.company_id=i.company_id AND s.item_id=i.id
           LEFT JOIN item_sale_rankings sale_rank
             ON sale_rank.company_id=i.company_id AND sale_rank.item_id=i.id
             AND sale_rank.as_of_date=$2::date
           LEFT JOIN staged_item_sale_rankings staged_rank
             ON staged_rank.company_id=i.company_id AND staged_rank.item_id=i.id
             AND staged_rank.as_of_date=$2::date
           LEFT JOIN LATERAL (
             SELECT SUM(quantity_delta) AS month_delta
             FROM legacy_sales_planning_daily_deltas d
             WHERE d.company_id=i.company_id AND d.item_id=i.id
               AND d.document_date BETWEEN
                 ($2::date-INTERVAL '1 month'+INTERVAL '1 day')::date AND $2::date
           ) planning_fix ON TRUE
           WHERE i.company_id=$1 AND i.order_alert_quantity IS NOT NULL
         ), filtered AS MATERIALIZED (
           SELECT * FROM candidates f
           WHERE ($3::text='' OR f.name ILIKE $3 OR f.code ILIKE $3)
             AND ($4::text='all' OR ($4::text='active' AND f.active)
               OR ($4::text='archived' AND NOT f.active))
             AND ($5::text='all' OR ($5::text='low' AND f.active AND f.below_limit)
               OR ($5::text='above' AND f.active AND NOT f.below_limit))
             AND ($6::integer IS NULL OR f.id=$6::integer)
         )
         SELECT counts.total,f.*
         FROM (SELECT COUNT(*)::integer AS total FROM filtered) counts
         LEFT JOIN LATERAL (
           SELECT * FROM filtered f ORDER BY ${order} LIMIT $7 OFFSET $8
         ) f ON TRUE`,
        params,
      );
      const notificationsEnabled = (await client.query<{ enabled: boolean }>(
        `SELECT COALESCE(BOOL_AND(enabled),true) AS enabled
         FROM page_settings
         WHERE page_key='company.notifications' AND (company_id IS NULL OR company_id=$1)`,
        [companyId],
      )).rows[0]?.enabled ?? true;
      const blockedImport = !!(await client.query(
        `SELECT 1 FROM legacy_import_runs
         WHERE company_id=$1 AND status<>'completed'
           AND (defer_projections OR status='rebuilding') LIMIT 1`,
        [companyId],
      )).rowCount;
      const template = await effectiveTemplate(client, companyId, "ITEM_ORDER_LEVEL");
      return {
        asOf,
        summary: {
          activeConfigured: summary.activeConfigured,
          lowActive: summary.lowActive,
          aboveActive: summary.aboveActive,
          archivedConfigured: summary.archivedConfigured,
          suppressedLow: summary.suppressedLow,
          activeIncidents: summary.activeIncidents,
          notificationEnabled: !!template?.enabled,
          notifyOwner: !!template?.notifyOwner,
          workerBlocked: !notificationsEnabled || blockedImport,
        },
        total: Number(result.rows[0]?.total ?? 0),
        page: options.page,
        pageSize: options.pageSize,
        items: result.rows.filter(row => row.id != null).map(row => ({
          itemId: Number(row.id), code: String(row.code),
          name: String(row.name), active: Boolean(row.active),
          availableUnit1: String(row.available_unit1),
          saleQuantityMonth: String(row.sale_quantity_month),
          orderAlertQuantity: String(row.order_alert_quantity),
          differenceUnit1: String(row.difference_unit1),
          belowLimit: Boolean(row.below_limit),
        })),
      };
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json(data);
  }));
  return router;
}
