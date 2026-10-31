import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { readItems } from "./services/items.ts";
import { directoryEntries, assertDirectoryAccess } from "./services/pages.ts";
import { audit } from "./services/audit.ts";

/**
 * Shared company checklist kept in its own table. Never UPDATE items for
 * checkmarks: protect_item_master_identity() rejects changes without a new
 * revision, and bumping that revision would conflict with real card edits.
 */
export function itemTemporarySelectionRoutes(pool: Pool): Router {
  const router = Router();
  const base = "/companies/:companyId/item-temporary-selection";

  router.get(base, handler(async (req, res) => {
    const result = await readItems(pool, req, async (client, companyId) => {
      const selected = await client.query(
        `SELECT i.id, i.code, i.name
           FROM company_item_temporary_selections chosen
           JOIN items i ON i.company_id=chosen.company_id AND i.id=chosen.item_id
          WHERE chosen.company_id=$1 ORDER BY i.name, i.id`,
        [companyId],
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
      const entries = await directoryEntries(client, user, companyId);
      const listPage = entries.find(page => page.key === "company.item-options-list");
      if (!listPage) throw new HttpError(403, "forbidden", "قائمة الأصناف غير متاحة");
      assertDirectoryAccess(listPage, "edit");
      const found = await client.query(
        "SELECT id, code, name FROM items WHERE company_id=$1 AND id=$2",
        [companyId, itemId],
      );
      if (!found.rows[0])
        throw new HttpError(404, "item_not_found", "الصنف غير موجود في هذه الشركة");

      const changed = checked
        ? await client.query(
            `INSERT INTO company_item_temporary_selections
                 (company_id, item_id, selected_by)
               VALUES ($1, $2, $3)
               ON CONFLICT (company_id, item_id) DO NOTHING
               RETURNING item_id`,
            [companyId, itemId, user.id],
          )
        : await client.query(
            `DELETE FROM company_item_temporary_selections
               WHERE company_id=$1 AND item_id=$2 RETURNING item_id`,
            [companyId, itemId],
          );
      if (changed.rowCount) {
        await audit(client, user, "item.field.update", "item", itemId,
          { field: "temporarySelected", value: !checked },
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
      const entries = await directoryEntries(client, user, companyId);
      const listPage = entries.find(page => page.key === "company.item-options-list");
      if (!listPage) throw new HttpError(403, "forbidden", "قائمة الأصناف غير متاحة");
      assertDirectoryAccess(listPage, "edit");
      const updated = await client.query(
        "DELETE FROM company_item_temporary_selections WHERE company_id=$1",
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
