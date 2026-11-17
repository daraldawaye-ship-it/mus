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
      // Match the notification monitor and inventory's positive-batch rule.
      const eligible = kind === "expired"
        ? "b.batch_key < $2::text"
        : "b.batch_key >= $2::text AND b.batch_key <= ($2::date + 30)::text";
      const from = `FROM stock_balances b
        JOIN items i ON i.company_id=b.company_id AND i.id=b.item_id
          AND i.active AND i.has_expiry
        JOIN locations l ON l.company_id=b.company_id AND l.id=b.location_id AND l.active
        JOIN branches br ON br.company_id=l.company_id AND br.id=l.branch_id AND br.active
        WHERE b.company_id=$1 AND b.quantity_smallest>0 AND b.batch_key<>''
          AND (${eligible})`;
      const stats=(await client.query<{ batches:number; items:number }>(
        `SELECT COUNT(*)::integer AS batches, COUNT(DISTINCT b.item_id)::integer AS items
          ${from}`,[companyId,day],
      )).rows[0] ?? {batches:0,items:0};
      const term = query.q ? searchPattern(query.q,true) : "";
      const order: Record<typeof query.sortBy,string> = {
        expiry: "x.expiry_date", name: "x.name",
        quantity: "x.quantity_unit1", location: "x.location_name",
      };
      const sort = `${order[query.sortBy]} ${query.sortDir === "desc" ? "DESC" : "ASC"},x.item_id ASC,x.balance_id ASC`;
      const params=[companyId,day,term,query.pageSize,(query.page-1)*query.pageSize];
      const entries=await client.query(
        `WITH entries AS MATERIALIZED (
           SELECT b.id AS balance_id,b.item_id,i.code,i.name,
             l.name AS location_name,b.batch_key AS expiry_date,
             ROUND(b.quantity_smallest::numeric/
               GREATEST(i.factor2::numeric*i.factor3::numeric,1),4) AS quantity_unit1
           ${from}
           AND ($3::text='' OR i.name ILIKE $3 OR i.code ILIKE $3 OR l.name ILIKE $3)
         )
         SELECT counts.total,x.*
         FROM (SELECT COUNT(*)::integer AS total FROM entries) counts
         LEFT JOIN LATERAL (
           SELECT * FROM entries x ORDER BY ${sort} LIMIT $4 OFFSET $5
         ) x ON TRUE`,params,
      );
      return {
        kind, asOf:day, page:query.page, pageSize:query.pageSize,
        total:Number(entries.rows[0]?.total??0),
        summary: {items:stats.items,batches:stats.batches},
        items:entries.rows.filter(x=>x.balance_id!=null).map(x=>({
          balanceId:Number(x.balance_id),itemId:Number(x.item_id),
          code:String(x.code),name:String(x.name),locationName:String(x.location_name),
          expiryDate:String(x.expiry_date),quantityUnit1:String(x.quantity_unit1),
        })),
      };
    });
    res.setHeader("Cache-Control","private, no-store");
    res.json(result);
  }));
  return router;
}
