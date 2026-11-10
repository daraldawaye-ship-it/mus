import type { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { handler, parse } from "./http.ts";
import { itemCompositionDTO, itemCompositionSelect, itemDTO, itemSelect } from "./repositories/items.ts";
import { audit } from "./services/audit.ts";
import { mutateMaster } from "./services/masters.ts";

const positiveId = z.number().int().positive().max(2147483647);
const expected = z.object({
  id: positiveId,
  name: z.string().min(1).max(240),
  expectedForm: z.string().max(80),
});
const compositionCard = expected.extend({ revision: positiveId }).strict();
const itemCard = expected.extend({ compositionId: positiveId }).strict();
const compositionBatch = z.object({ cards: z.array(compositionCard).min(1).max(100) }).strict();
const itemBatch = z.object({ cards: z.array(itemCard).min(1).max(100) }).strict();
const piece = "قطعة";
const itemPath = "/companies/:companyId/items/form-corrections/piece";
const compositionPath = "/companies/:companyId/item-compositions/form-corrections/piece";
const catalogEntry = (schema: typeof compositionBatch | typeof itemBatch) => ({
  queryFields: [], pathParams: ["companyId"], source: "supply-piece-forms.ts", bodySchema: z.toJSONSchema(schema),
});
export const supplyPieceContracts = {
  ["PATCH " + itemPath]: catalogEntry(itemBatch),
  ["PATCH " + compositionPath]: catalogEntry(compositionBatch),
};

export function registerSupplyPieceForms(router: Router, pool: Pool) {
  for (const path of [itemPath, compositionPath]) {
    router.patch(path, handler(async (req, res) => {
      const isItem = path === itemPath;
      const cards = isItem ? parse(itemBatch, req.body).cards : parse(compositionBatch, req.body).cards;
      const result = await mutateMaster(pool, req, "items.manage", async (client, user, companyId) => {
        const ids = cards.map(card => card.id);
        const table = isItem ? "items" : "item_compositions";
        const select = isItem ? itemSelect : itemCompositionSelect;
        const alias = isItem ? "i" : "f";
        const selection = select + " WHERE " + alias + ".company_id=$1 AND " + alias + ".id=ANY($2::int[])";
        const rows = await client.query(selection + " ORDER BY " + alias + ".id FOR UPDATE OF " + alias, [companyId, ids]);
        const beforeRows = new Map(rows.rows.map(row => [Number(row.id), row]));
        const changed: number[] = [], already: number[] = [], conflicts: number[] = [];
        const visited = new Set<number>();
        for (const card of cards) {
          if (visited.has(card.id)) continue;
          visited.add(card.id);
          const row = beforeRows.get(card.id);
          const identityMatches = row?.active && ("compositionId" in card
            ? row.name === card.name && row.composition_id === card.compositionId && row.composition_active
            : row.arabic_name === card.name);
          if (!identityMatches || !row) conflicts.push(card.id);
          else if (row.product_form === piece) already.push(card.id);
          else if (row.product_form !== card.expectedForm || ("revision" in card && row.revision !== card.revision))
            conflicts.push(card.id);
          else changed.push(card.id);
        }

        if (changed.length) {
          await client.query("UPDATE " + table + " SET product_form=$1,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$2 AND id=ANY($3::int[])",
            [piece, companyId, changed]);
          const afterRows = await client.query(selection, [companyId, changed]);
          for (const row of afterRows.rows) {
            const previous = beforeRows.get(Number(row.id))!;
            if (isItem) {
              await audit(client, user, "item.update", "item", row.id, itemDTO(previous), itemDTO(row), companyId);
              const field = {field: "productForm", label: "الشكل"};
              await audit(client, user, "item.field.update", "item", row.id,
                {...field, value: previous.product_form}, {...field, value: row.product_form}, companyId);
            } else {
              await audit(client, user, "itemComposition.update", "itemComposition", row.id,
                itemCompositionDTO(previous), itemCompositionDTO(row), companyId);
            }
          }
        }
        return { changed, already, conflicts };
      });
      res.json(result);
    }));
  }
}
