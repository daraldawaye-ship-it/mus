import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { itemFieldPatchSchema } from "../packages/contracts/src/items.ts";

test("review marker migration defaults existing and new items to false and stores true", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE items (id integer PRIMARY KEY); INSERT INTO items VALUES (1)");
    await db.exec(readFileSync("apps/api/migrations/20261116_item_reviewed.sql", "utf8"));
    await db.exec("INSERT INTO items (id) VALUES (2); UPDATE items SET reviewed=true WHERE id=1");
    assert.deepEqual((await db.query("SELECT id,reviewed FROM items ORDER BY id")).rows,
      [{ id: 1, reviewed: true }, { id: 2, reviewed: false }]);
    await assert.rejects(db.exec("UPDATE items SET reviewed=null WHERE id=1"));
  } finally { await db.close(); }
});

test("review changes validate booleans without populating unrelated item fields", () => {
  const patch = itemFieldPatchSchema.parse({ changes: { reviewed: true }, expected: { reviewed: false } });
  assert.deepEqual(patch.changes, { reviewed: true });
  assert.deepEqual(patch.expected, { reviewed: false });
  assert.equal(itemFieldPatchSchema.safeParse({ changes: { reviewed: "true" }, expected: { reviewed: false } }).success, false);
  assert.deepEqual(itemFieldPatchSchema.parse({ changes: { name: "Test" }, expected: { name: "Old" } }).changes, { name: "Test" });
});

test("opening and resetting item options leave requested ranges blank while preserving explicit values", () => {
  const source = readFileSync("apps/web/src/pages/ItemOptionsListPage.tsx", "utf8");
  const fn = source.slice(source.indexOf("function readDraft("), source.indexOf("/** Convert links"));
  const script = ts.transpile(fn + "\nglobalThis.read = readDraft;", { target: ts.ScriptTarget.ES2022 });
  const context = vm.createContext({});
  vm.runInContext(script, context);
  const blank = context.read(new URLSearchParams());
  for (const key of ["monthMin", "yearMin", "coverageWithReserveMax"]) assert.equal(blank[key], "");
  const explicit = context.read(new URLSearchParams("monthMin=3&yearMin=5&coverageWithReserveMax=7"));
  assert.equal(explicit.monthMin, "3");
  assert.equal(explicit.yearMin, "5");
  assert.equal(explicit.coverageWithReserveMax, "7");
  assert.equal(blank.orderTargetDays, "1");
  const reset = source.slice(source.indexOf("function reset()"), source.indexOf("function rememberItem("));
  for (const key of ["monthMin", "yearMin", "coverageWithReserveMax"]) assert.ok(reset.includes(key + ': ""'));
});
