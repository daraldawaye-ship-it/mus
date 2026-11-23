import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { itemFieldPatchSchema, itemPatchSchema, itemSchema } from "../packages/contracts/src/items.js";

const migration = readFileSync(
  new URL("../apps/api/migrations/20261123_item_default_supply_limit.sql", import.meta.url), "utf8",
);
const base = { name: "Sample", currencyId: 1, idempotencyKey: "6c12632b-bfee-443f-8f59-941c745ae363" };

test("supply fields are optional in legacy payloads and editable independently", () => {
  const created = itemSchema.parse(base);
  assert.equal(Object.hasOwn(created, "defaultSupplyMaxQuantity"), false);
  assert.equal(Object.hasOwn(created, "defaultSupplyMaxNotes"), false);
  const updated = itemPatchSchema.parse({name: base.name, currencyId: base.currencyId, revision: 1});
  assert.equal(Object.hasOwn(updated, "defaultSupplyMaxQuantity"), false);
  assert.equal(Object.hasOwn(updated, "defaultSupplyMaxNotes"), false);
  const parsed = itemFieldPatchSchema.parse({
    changes: { defaultSupplyMaxQuantity: "٠", defaultSupplyMaxNotes: "  " },
    expected: { defaultSupplyMaxQuantity: null, defaultSupplyMaxNotes: "previous" },
  });
  assert.deepEqual(parsed.changes, { defaultSupplyMaxQuantity: "0", defaultSupplyMaxNotes: null });
  const cleared = itemFieldPatchSchema.parse({
    changes: { defaultSupplyMaxQuantity: null }, expected: { defaultSupplyMaxQuantity: "0" },
  });
  assert.deepEqual(cleared.changes, { defaultSupplyMaxQuantity: null });
  assert.equal(itemSchema.safeParse({...base, defaultSupplyMaxQuantity: "-1"}).success, false);
  assert.equal(itemSchema.safeParse({...base, defaultSupplyMaxQuantity: "1.5"}).success, false);
  assert.equal(itemSchema.safeParse({...base, defaultSupplyMaxNotes: "a".repeat(1001)}).success, false);
});

test("migration leaves old and new cards blank and persists independent quantity and notes", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("CREATE TABLE items (id int PRIMARY KEY, reserve_quantity int NOT NULL DEFAULT 0); INSERT INTO items VALUES (1, 5)");
  await db.exec(migration);
  await db.exec("INSERT INTO items (id) VALUES (2)");
  const read = async () => (await db.query(
    "SELECT id,reserve_quantity,default_supply_max_quantity::text AS quantity,default_supply_max_notes AS notes FROM items ORDER BY id"
  )).rows;
  assert.deepEqual(await read(), [
    {id: 1, reserve_quantity: 5, quantity: null, notes: null},
    {id: 2, reserve_quantity: 0, quantity: null, notes: null},
  ]);
  await db.query("UPDATE items SET default_supply_max_quantity = $1, default_supply_max_notes = $2 WHERE id = 1", ["0", "مؤقت"]);
  assert.deepEqual((await read())[0], {id: 1, reserve_quantity: 5, quantity: "0", notes: "مؤقت"});
  await db.exec("UPDATE items SET default_supply_max_quantity = NULL WHERE id = 1");
  assert.deepEqual((await read())[0], {id: 1, reserve_quantity: 5, quantity: null, notes: "مؤقت"});
  await assert.rejects(db.exec("UPDATE items SET default_supply_max_quantity = -1 WHERE id = 1"), /check constraint/);
});
