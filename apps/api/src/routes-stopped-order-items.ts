import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { actor, handler, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { readItems } from "./services/items.ts";
import { directoryEntries } from "./services/pages.ts";
import { searchPattern } from "./services/lists.ts";

const querySchema = z.object({
  q: z.string().trim().max(120).default(""),
  itemId: z.coerce.number().int().positive().optional(),
  status: z.enum(["current", "ended", "all"]).default("current"),
  sortBy: z.enum(["stopDate", "name", "code"]).default("stopDate"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
}).strip();

export function stoppedOrderItemsRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/companies/:companyId/stopped-order-items", handler(async (req, res) => {
    const options = parse(querySchema, req.query);
    const result = await readItems(pool, req, async (client, companyId) => {
      const directory = await directoryEntries(client, actor(req), companyId);
      const permitted = ["company.stopped-order-items", "company.items"].every(key => {
        const page = directory.find(entry => entry.key === key);
        return !!page?.enabled && !!page.actionAccess.view;
      });
      if (!permitted)
        throw new HttpError(403, "forbidden", "ليست لديك صلاحية متابعة الأصناف المتوقف طلبها");

      const today = String((await client.query(
        "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today",
      )).rows[0].today);
      const params: unknown[] = [
        companyId,
        options.itemId ?? null,
        options.q ? searchPattern(options.q, true) : "",
        options.status,
        today,
      ];
      // A link from an older alert still identifies its original item even
      // when its stop has since expired or been removed.
      const where = `i.company_id=$1 AND
        (($2::integer IS NOT NULL AND i.id=$2::integer) OR
         ($2::integer IS NULL AND i.order_stopped_until IS NOT NULL
          AND ($3::text='' OR i.code ILIKE $3 OR i.name ILIKE $3 OR i.english_name ILIKE $3)
          AND ($4::text='all'
            OR ($4::text='current' AND i.order_stopped_until>$5::date)
            OR ($4::text='ended' AND i.order_stopped_until<=$5::date))))`;
      const sortable = {
        stopDate: "i.order_stopped_until",
        name: "i.name",
        code: "i.code",
      };
      const order = sortable[options.sortBy] + (options.sortDir === "desc" ? " DESC NULLS LAST" : " ASC NULLS LAST") + ",i.id ASC";
      const total = (await client.query<{total:number}>(
        `SELECT COUNT(*)::integer AS total FROM items i WHERE ${where}`,params,
      )).rows[0]?.total ?? 0;
      const pageRows = await client.query<{
        id:number;code:string;name:string;active:boolean;
        order_stopped_until:string|null;order_alert_quantity:string|null;
      }>(`SELECT i.id,i.code,i.name,i.active,
          i.order_stopped_until::text AS order_stopped_until,
          i.order_alert_quantity::text AS order_alert_quantity
        FROM items i WHERE ${where} ORDER BY ${order} LIMIT $6 OFFSET $7`,
        [...params, options.pageSize, (options.page-1)*options.pageSize]);
      const summary = (await client.query<{
        currentCount:number;endedCount:number;
      }>(`SELECT COUNT(*) FILTER(WHERE order_stopped_until>$2::date)::integer AS "currentCount",
                 COUNT(*) FILTER(WHERE order_stopped_until<=$2::date)::integer AS "endedCount"
          FROM items WHERE company_id=$1 AND order_stopped_until IS NOT NULL`,
        [companyId,today])).rows[0];
      return {
        asOf: today,total,page:options.page,pageSize:options.pageSize,
        summary,
        items:pageRows.rows.map(row=>({
          itemId:row.id,code:row.code,name:row.name,active:row.active,
          orderStoppedUntil:row.order_stopped_until,
          orderAlertQuantity:row.order_alert_quantity,
          currentlyStopped:!!row.order_stopped_until && row.order_stopped_until>today,
        })),
      };
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result);
  }));
  return router;
}
