import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { readItems } from "./services/items.ts";
import { audit } from "./services/audit.ts";

/** Shared, company-scoped item checkmarks, independent of item-card revisions. */
export function itemTemporarySelectionRoutes(pool: Pool): Router {
  const router = Router();
  const base = "/companies/:companyId/item-temporary-selection";

  router.get(base, handler(async (req, res) => {
    const result = await readItems(pool, req, async (client, companyId) => {
      const selected = await client.query(
        `SELECT id, code, name FROM items
         WHERE company_id=$1 AND temporary_selected=true
         ORDER BY name, id`, [companyId],
      );
      return selected.rows.map(row => ({
        id: Number(row.id), code: String(row.code), name: String(row.name),
      }));
    });
    res.json({ items: result });
  }));

  router.patch(`${base}/:itemId`, handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const itemId = id(req.params.itemId);
    const { checked } = parse(z.object({ checked: z.boolean() }).strict(), req.body);
    const item = await transaction(pool, async client => {
      const user = await currentActor(client, actor(req));
      await companyAccess(client, user, companyId, "items.view");
      const found = await client.query(
        `SELECT id,code,name,temporary_selected FROM items
         WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, itemId],
      );
      if (!found.rows[0])
        throw new HttpError(404, "item_not_found", "الصنف غير موجود في هذه الشركة");
      const previous = Boolean(found.rows[0].temporary_selected);
      if (previous !== checked) {
        await client.query(
          "UPDATE items SET temporary_selected=$3 WHERE company_id=$1 AND id=$2",
          [companyId, itemId, checked],
        );
        await audit(client, user, "item.field.update", "item", itemId,
          { field: "temporarySelected", value: previous },
          { field: "temporarySelected", value: checked }, companyId);
      }
      return { id: itemId, code: String(found.rows[0].code),
        name: String(found.rows[0].name), checked };
    });
    res.json({ item });
  }));

  router.delete(base, handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    parse(z.object({ confirm: z.literal(true) }).strict(), req.body);
    const result = await transaction(pool, async client => {
      const user = await currentActor(client, actor(req));
      await companyAccess(client, user, companyId, "items.view");
      const updated = await client.query(
        "UPDATE items SET temporary_selected=false WHERE company_id=$1 AND temporary_selected=true",
        [companyId],
      );
      const cleared = updated.rowCount ?? 0;
      if (cleared) await audit(client, user, "item.field.update",
        "itemTemporarySelection", null,
        { selectedCount: cleared }, { selectedCount: 0 }, companyId);
      return { cleared };
    });
    res.json({ result });
  }));

  return router;
}
