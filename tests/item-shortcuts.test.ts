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

test("two-letter shortcuts accept Arabic and Latin and normalize Latin case", () => {
  assert.equal(createShortcut("اب").success, true);
  const latin = createShortcut("ab");
  assert.equal(latin.success, true);
  if (latin.success) assert.equal(latin.data.shortcut, "AB");
  assert.equal(createShortcut("").success, true);
});
test("shortcut must contain exactly two letters; no numbers, spaces or punctuation", () => {
  for (const invalid of ["ا", "ABC", "A1", "12", "A!", "a b", "ا1", "a\n"]) {
    assert.equal(createShortcut(invalid).success, false, invalid);
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
