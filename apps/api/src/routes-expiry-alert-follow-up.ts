import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { actor, handler, parse } from "./http.ts";
import { readItems } from "./services/items.ts";
import { directoryEntries } from "./services/pages.ts";
import { HttpError } from "./errors.ts";
import { searchPattern } from "./services/lists.ts";

const querySchema = z.object({
  q: z.string().trim().max(120).default(""),
  sortBy: z.enum(["expiry", "name", "quantity", "location"]).default("expiry"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(20).max(100).default(50),
}).strip();

/** One record per item, using the explicitly saved nearest expiry on its card.
 * Stock is the NET available quantity (showroom + non-return warehouses),
 * not a sum of positive lots without offsetting negative lots.
 * Detail by batch remains in the separate stock balances view.
 */
export function expiryAlertFollowUpRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/companies/:companyId/expiry-alert-follow-up/:kind",handler(async(req,res)=>{
    const kind = req.params.kind;
    if (kind !== "expired" && kind !== "expiring-30")
      throw new HttpError(400,"invalid_expiry_group","نوع متابعة الصلاحية غير صالح");
    const query = parse(querySchema,req.query);
    const result = await readItems(pool,req,async(client,companyId)=>{
      const directory = await directoryEntries(client,actor(req),companyId);
      const pageKey = kind === "expired" ?
        "company.expired-items-follow-up" : "company.expiring-items-follow-up";
      for (const key of [pageKey,"company.stock-balances","company.items"]) {
        const entry = directory.find(x=>x.key===key);
        if (!entry?.enabled || !entry.actionAccess.view)
          throw new HttpError(403,"forbidden","ليس لديك صلاحية عرض متابعة انتهاء الأصناف");
      }
      const day = String((await client.query(
        "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today",
      )).rows[0].today);
      // These predicates intentionally match the group notification scanner.
      const eligible = kind === "expired"
        ? "i.nearest_expiry_date < $2::date"
        : "i.nearest_expiry_date >= $2::date AND i.nearest_expiry_date <= ($2::date + 30)";
      const base = `FROM items i
        JOIN item_statistics stats ON stats.company_id=i.company_id AND stats.item_id=i.id
        WHERE i.company_id=$1 AND i.active AND i.has_expiry
          AND i.nearest_expiry_date IS NOT NULL
          AND COALESCE(stats.stock_showroom,0)+COALESCE(stats.stock_warehouse,0)>0
          AND (${eligible})`;
      const term = query.q ? searchPattern(query.q,true) : "";
      const order: Record<typeof query.sortBy,string> = {
        expiry: "x.expiry_date", name: "x.name",
        quantity: "x.quantity_unit1", location: "x.name",
      };
      const sort = `${order[query.sortBy]} ${query.sortDir === "desc" ? "DESC" : "ASC"},x.item_id ASC`;
      const params=[companyId,day,term,query.pageSize,(query.page-1)*query.pageSize];
      const entries=await client.query(
        `WITH entries AS MATERIALIZED (
           SELECT i.id AS item_id,i.code,i.name,
             i.nearest_expiry_date::text AS expiry_date,
             i.unit1_name AS unit1_name,
             ROUND((COALESCE(stats.stock_showroom,0)+COALESCE(stats.stock_warehouse,0))::numeric/
               GREATEST(i.factor2::numeric*i.factor3::numeric,1),4) AS quantity_unit1
           ${base}
           AND ($3::text='' OR i.name ILIKE $3 OR i.code ILIKE $3
             OR i.english_name ILIKE $3)
         )
         SELECT counts.total,x.*
         FROM (SELECT COUNT(*)::integer AS total FROM entries) counts
         LEFT JOIN LATERAL (
           SELECT * FROM entries x ORDER BY ${sort} LIMIT $4 OFFSET $5
         ) x ON TRUE`,params,
      );
      const summary=(await client.query<{ items:number }>(
        `SELECT COUNT(*)::integer AS items ${base}`,[companyId,day],
      )).rows[0] ?? {items:0};
      return {
        kind,asOf:day,page:query.page,pageSize:query.pageSize,
        total:Number(entries.rows[0]?.total??0),
        summary:{items:summary.items},
        items:entries.rows.filter(x=>x.item_id!=null).map(x=>({
          itemId:Number(x.item_id),code:String(x.code),
          name:String(x.name),expiryDate:String(x.expiry_date),
          quantityUnit1:String(x.quantity_unit1),unit1Name:String(x.unit1_name),
        })),
      };
    });
    res.setHeader("Cache-Control","private, no-store");
    res.json(result);
  }));
  return router;
}
