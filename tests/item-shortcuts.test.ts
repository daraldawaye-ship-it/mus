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

test("two-character shortcuts accept Arabic, Latin, digits and mixed pairs", () => {
  for (const value of ["اب", "AB", "12", "A1", "1A", "ا1", "١٢", "۱۲", "أب"]) {
    assert.equal(createShortcut(value).success, true, value);
  }
  const latin = createShortcut("ab");
  assert.equal(latin.success, true);
  if (latin.success) assert.equal(latin.data.shortcut, "AB");
  const arabicDigits = createShortcut("١٢");
  assert.equal(arabicDigits.success, true);
  if (arabicDigits.success) assert.equal(arabicDigits.data.shortcut, "12");
  const mixedDigits = createShortcut("a٢");
  assert.equal(mixedDigits.success, true);
  if (mixedDigits.success) assert.equal(mixedDigits.data.shortcut, "A2");
  assert.equal(createShortcut("").success, true);
});
test("shortcuts require two alphanumeric characters and disallow punctuation", () => {
  for (const invalid of ["ا", "1", "ABC", "123", "A!", "a b", "!2", "a\\n"]) {
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
