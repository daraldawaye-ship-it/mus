import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { itemSchema, itemPatchSchema } from "../packages/contracts/src/items.ts";

function createShortcut(shortcut: string) {
  return itemSchema.safeParse({
    name: "صنف تجريبي",
    currencyId: 1,
    idempotencyKey: randomUUID(),
    shortcut,
  });
}

test("one and two character shortcuts including punctuation", () => {
  for (const input of ["a", "AB", "5", "5.", "++", "+", ".", "A1", "١٢", "ا1"]) {
    assert.equal(createShortcut(input).success, true, input);
  }
  const normalized = createShortcut("٥.");
  assert.equal(normalized.success, true);
  if (normalized.success) assert.equal(normalized.data.shortcut, "5.");
});
test("three characters, whitespace, and reserved zero are invalid", () => {
  for (const input of ["123", "ABC", "A B", "0", "  "]) {
    assert.equal(createShortcut(input).success, false, input);
  }
});
test("legacy clients omitting shortcut on PATCH remain valid", () => {
  assert.equal(itemPatchSchema.shape.shortcut.safeParse(undefined).success, true);
});
test("shortcut storage is scoped by company and case insensitive even for archived items", () => {
  const sql = readFileSync(
    new URL("../apps/api/migrations/159_item_two_character_shortcuts.sql", import.meta.url), "utf8",
  );
  assert.match(sql, /UNIQUE INDEX/i);
  assert.match(sql, /company_id, lower\(shortcut\)/);
  assert.doesNotMatch(sql, /active\s*=|WHERE\s+active/i);
});
