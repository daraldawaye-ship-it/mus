import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { itemFieldPatchSchema } from "../packages/contracts/src/items.ts";

const route = readFileSync("apps/api/src/routes-items.ts", "utf8");
const page = readFileSync("apps/web/src/pages/ItemsPages.tsx", "utf8");
const editor = page.slice(page.indexOf("function ItemEditor({"), page.indexOf("function UnitPreview({"));

test("an item update carries exactly the touched fields and their original values", () => {
  const valid = itemFieldPatchSchema.safeParse({
    changes: { clearanceFrom: "2026-11-02", clearanceTo: null },
    expected: { clearanceFrom: "2026-11-01", clearanceTo: "2026-11-30" },
  });
  assert.equal(valid.success, true);
  assert.deepEqual(Object.keys(valid.data?.changes ?? {}), ["clearanceFrom", "clearanceTo"]);
  assert.equal(itemFieldPatchSchema.safeParse({ changes: {}, expected: {} }).success, false);
  assert.equal(itemFieldPatchSchema.safeParse({
    changes: { commissionRate: "12" }, expected: {},
  }).success, false);
  assert.equal(itemFieldPatchSchema.safeParse({
    changes: { clearanceTo: null }, expected: { clearanceTo: null, name: "unused" },
  }).success, false);
  assert.equal(itemFieldPatchSchema.safeParse({
    changes: { revision: 15 }, expected: { revision: 14 },
  }).success, false);
});

test("server locks item and rejects stale values only for modified fields", () => {
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /Object\.entries\(fieldPatch\.expected\)/);
  assert.match(route, /existing\[field\]/);
  assert.match(route, /\.\.\.fieldPatch\.changes/);
  assert.match(route, /parse\(itemPatchSchema/);
  assert.match(route, /AND revision=\$\{values\.length\}/);
  assert.match(route, /columnsToUpdate/);
  assert.match(route, /supplierChanged/);
  assert.match(route, /itemClearanceNotice\(before, next/);
});

test("editor tracks touched fields, submits a field-level patch and rebases after a save", () => {
  assert.match(editor, /editedFields = useRef\(new Map/);
  assert.match(editor, /markDirty\(key\)/);
  assert.match(editor, /markDirty\("currencyId"\)/);
  assert.match(editor, /markDirty\("supplierAccountId"\)/);
  assert.match(editor, /markDirty\("agentId"\)/);
  assert.match(editor, /savePayload = fieldPayload\.data/);
  assert.match(editor, /for \(const field of selectedField \? \[selectedField\] : \[\]\)/);
  assert.match(editor, /itemFieldPatchSchema\.safeParse\(\{ changes, expected \}\)/);
  assert.match(editor, /blockedFields\.current\.add\(selectedField\)/);
  assert.match(editor, /setFields\(previous => \{/);
  assert.match(editor, /lastEditedField\.current/);
  assert.match(editor, /body: savePayload/);
  assert.match(editor, /lastSavedSnapshot\.current = result\.item/);
  assert.doesNotMatch(editor, /body: parsed\.data/);
});

test("one stale field never blocks saving an independently edited field", () => {
  assert.match(editor, /\[\.\.\.editedFields\.current\.keys\(\)\]\.find\(key => !blockedFields\.current\.has\(key\)\)/);
  assert.match(editor, /editedFields\.current\.delete\(selectedField\)/);
  assert.doesNotMatch(editor, /for \(const \[field, version\] of editedFields\.current\)/);
  assert.doesNotMatch(editor, /\(conflict && !confirmedCurrent\)/);
  assert.match(editor, /lastSavedSnapshot\.current = latest\.item/);
  assert.match(editor, /for \(const key of editedFields\.current\.keys\(\)\)/);
});
