import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { itemOptionsPresetFiltersSchema } from "../packages/contracts/src/item-options-presets.ts";

const old = { q: "", active: "active", stockMin: "", stockMax: "", monthMin: "", monthMax: "",
  fourMonthsMin: "", fourMonthsMax: "", allTimeMin: "", allTimeMax: "", coverageMin: "", coverageMax: "",
  excludeZero: true, sortBy: "allTime", sortDir: "desc" };

test("old zero exclusion is removed; review exclusion defaults off and round-trips independently", () => {
  const decoded = itemOptionsPresetFiltersSchema.parse(old);
  assert.equal("excludeZero" in decoded, false);
  assert.equal(decoded.excludeReviewed, false);
  const saved = itemOptionsPresetFiltersSchema.parse({ ...decoded, excludeReviewed: true,
    planningColumnsVersion: 1, visibleColumns: ["minOrderQuantity", "orderAlertQuantity", "orderStoppedUntil", "reviewed"] });
  assert.equal(saved.excludeReviewed, true);
  assert.equal(saved.visibleColumns?.length, 4);
  assert.deepEqual(itemOptionsPresetFiltersSchema.parse(JSON.parse(JSON.stringify(saved))), saved);
});

test("preset cleanup deletes only retired field, retaining names, columns, thresholds and new review choice", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE company_item_options_presets (id integer PRIMARY KEY, name text, filters jsonb)");
    const filters = { ...old, excludeReviewed: true, stockMin: "0", stockMax: "0", visibleColumns: ["stock"] };
    await db.query("INSERT INTO company_item_options_presets VALUES (1,$1,$2)", ["Zero stock", JSON.stringify(filters)]);
    await db.exec(readFileSync("apps/api/migrations/20261116_retire_zero_item_filter.sql", "utf8"));
    const row = (await db.query<{ id: number; name: string; filters: typeof filters }>("SELECT * FROM company_item_options_presets")).rows[0];
    const { excludeZero, ...expected } = filters;
    assert.deepEqual(row, { id: 1, name: "Zero stock", filters: expected });
  } finally { await db.close(); }
});
