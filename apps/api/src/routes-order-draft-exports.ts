import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { directoryEntries, assertDirectoryAccess } from "./services/pages.ts";
import { HttpError } from "./errors.ts";

const exportInput = z.object({
  items: z.array(z.object({
    id: z.number().int().positive().max(2147483647),
    requiredQuantity: z.string().regex(/^[0-9]{1,16}(?:\.[0-9]{1,6})?$/).nullable(),
  }).strict()).min(1).max(20000),
}).strict();

export function orderDraftExportsRoutes(pool: Pool): Router {
  const router = Router();
  const base = "/companies/:companyId/order-draft-exports";
  async function checkAccess(client: PoolClient, req: Request, companyId: number, requireDraft = false) {
    const user = await currentActor(client, actor(req), false);
    await companyAccess(client, user, companyId, "items.view");
    const entries = await directoryEntries(client, user, companyId);
    // Export/print is an action from the order drafts page itself. Requiring
    // separate access to the history page here prevents staff who may view
    // drafts from printing or exporting them. History reads remain protected.
    const pageKey = requireDraft ? "company.item-options-list" : "company.order-draft-exports";
    const page = entries.find(entry => entry.key === pageKey);
    if (!page) throw new HttpError(403, "forbidden",
      requireDraft ? "مسودات الطلبيات غير متاحة" : "صفحة سجل الطلبيات غير متاحة");
    assertDirectoryAccess(page, "view");
    return user;
  }
  const clearExpired = (client: PoolClient) => client.query(
    "DELETE FROM company_order_draft_exports WHERE export_date < (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date - 40",
  );

  router.post(base, handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const input = parse(exportInput, req.body);
    const unique = [...new Map(input.items.map(row => [row.id, row])).values()];
    const result = await transaction(pool, async client => {
      const user = await checkAccess(client, req, companyId, true);
      await clearExpired(client);
      const existing = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM items WHERE company_id=$1 AND id=ANY($2::integer[])",
        [companyId, unique.map(row => row.id)]);
      if (Number(existing.rows[0]?.count ?? 0) !== unique.length)
        throw new HttpError(409, "items_changed", "أحد الأصناف لم يعد موجودًا بالشركة؛ لم يتم حفظ ترحيل ناقص");
      const rows = await client.query(
        `WITH requested AS (
          SELECT id,required_quantity FROM jsonb_to_recordset($2::jsonb)
          AS row(id integer,required_quantity numeric)
        ), inserted AS (
          INSERT INTO company_order_draft_exports
            (company_id,item_id,item_name,required_quantity,available_quantity,export_date,created_by)
          SELECT $1,i.id,i.name,r.required_quantity,
            round((COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0))
              / greatest(i.factor2::numeric*i.factor3::numeric,1),4),
            (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date,$3
          FROM requested r JOIN items i ON i.company_id=$1 AND i.id=r.id
          LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id
          ON CONFLICT(company_id,item_id,export_date) DO NOTHING
          RETURNING id
        ) SELECT count(*)::integer AS added FROM inserted`,
        [companyId,JSON.stringify(unique.map(row => ({ id:row.id,required_quantity:row.requiredQuantity }))),user.id],
      );
      return { added: Number(rows.rows[0].added), skipped: unique.length-Number(rows.rows[0].added) };
    });
    res.status(201).json(result);
  }));

  router.get(base + "/purchase-comparison", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const period = parse(z.enum(["yesterday", "three-days"]).default("yesterday"), req.query.period);
    const threeDays = period === "three-days";
    const items = await transaction(pool, async client => {
      const user = await checkAccess(client, req, companyId);
      await companyAccess(client, user, companyId, "commerce.view");
      const result = await client.query(
        `WITH days AS (SELECT (now() AT TIME ZONE 'Asia/Aden')::date AS today),
        requested AS (
          SELECT item_id, max(required_quantity) AS quantity
          FROM company_order_draft_exports, days
          WHERE company_id=$1 AND export_date BETWEEN today-$2::int AND today-$3::int
          GROUP BY item_id
        ), purchased AS (
          SELECT l.item_id, sum(l.smallest_quantity / (l.factor2::numeric * l.factor3)) AS quantity
          FROM invoices i JOIN invoice_lines l ON l.company_id=i.company_id AND l.invoice_id=i.id
          CROSS JOIN days
          WHERE i.company_id=$1 AND i.kind='purchase' AND i.posted AND l.quantity>0
            AND i.document_date BETWEEN today-$2::int AND today
          GROUP BY l.item_id
        )
        SELECT i.id AS "itemId", i.name AS "itemName",
          CASE WHEN r.item_id IS NULL THEN '0' ELSE trim_scale(r.quantity)::text END AS "requested",
          trim_scale(coalesce(p.quantity,0))::text AS "purchased"
        FROM requested r FULL JOIN purchased p USING (item_id)
        JOIN items i ON i.company_id=$1 AND i.id=coalesce(r.item_id,p.item_id)
        ORDER BY i.name,i.id`, [companyId, threeDays ? 2 : 1, threeDays ? 0 : 1]);
      return result.rows;
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ items });
  }));

  router.get(base, handler(async (req,res) => {
    const companyId = id(req.params.companyId);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const p = typeof req.query.page === "string" ? Number(req.query.page) : 1;
    if (q.length > 120 || !Number.isInteger(p) || p < 1 || p > 100000)
      throw new HttpError(400,"invalid_query","البحث أو الصفحة غير صالح");
    const result = await transaction(pool, async client => {
      await checkAccess(client, req, companyId);
      await clearExpired(client);
      const filter = `company_id=$1 AND ($2::text='' OR item_name ILIKE $3 OR item_id::text=$2)`;
      const params = [companyId,q,"%"+q.replace(/[\\%_]/g, "\\$&")+"%"];
      const count = await client.query(`SELECT count(*)::integer AS total FROM company_order_draft_exports WHERE ${filter}`, params);
      const items = await client.query(
        `SELECT id,item_id AS "itemId",item_name AS "itemName",
          required_quantity::text AS "requiredQuantity",
          available_quantity::text AS "availableQuantity",
          export_date::text AS "exportDate",exported_at::text AS "exportedAt"
          FROM company_order_draft_exports WHERE ${filter}
          ORDER BY exported_at DESC,id DESC LIMIT 100 OFFSET $4`, [...params,(p-1)*100]);
      return { items:items.rows,total:count.rows[0].total,page:p,pageSize:100 };
    });
    res.setHeader("Cache-Control","private, no-store");
    res.json(result);
  }));
  return router;
}
