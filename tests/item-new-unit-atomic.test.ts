import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { itemFieldPatchSchema, itemPatchSchema } from "../packages/contracts/src/items.ts";
import { addsOnlyPreviouslyInactiveUnits } from "../apps/api/src/services/item-unit-history.ts";

test("new unused second unit accepts one atomic name+factor patch", () => {
  const normalized=itemFieldPatchSchema.safeParse({
    changes:{ unit2Name:"أمبولة", factor2:"5" },
    expected:{ unit2Name:"", factor2:1 },
    mode:"last-write-wins",
  });
  assert.equal(normalized.success,true,normalized.success?"":normalized.error.message);
  if(normalized.success){
    assert.deepEqual(Object.keys(normalized.data.changes),["unit2Name","factor2"]);
    assert.equal(normalized.data.changes.factor2,5);
  }
  const initial={
    unit1Name:"باكت",unit2Name:"",unit3Name:"",
    factor2:1,factor3:1,hasExpiry:true,
  };
  assert.equal(addsOnlyPreviouslyInactiveUnits(initial,{
    ...initial,unit2Name:"أمبولة",factor2:5,
  }),true);
  assert.equal(addsOnlyPreviouslyInactiveUnits({
    ...initial,unit2Name:"أمبولة",factor2:5,
  },{
    ...initial,unit2Name:"حبة",factor2:7,
  }),false,"existing active unit must remain protected");
});

test("field-level autosave sends complete touched pair and rebases both on success",()=>{
  const page=readFileSync("apps/web/src/pages/ItemsPages.tsx","utf8");
  assert.match(page,/const unitPair = selectedField === "unit2Name"/);
  assert.match(page,/\["unit2Name", "factor2"\] as const/);
  assert.match(page,/\["unit3Name", "factor3"\] as const/);
  assert.match(page,/selectedFields: EditableItemField\[\]/);
  assert.match(page,/unitPair\.filter\(field => editedFields\.current\.has\(field\)/);
  assert.match(page,/if \(unitPair && \(!parsedUnitFactor\?\.success/);
  assert.match(page,/setError\("أكمل اسم الوحدة وعددها داخل الوحدة السابقة قبل الحفظ\."\)/);
  assert.match(page,/for \(const field of selectedFields\) \{/g);
  assert.match(page,/editedFields\.current\.delete\(field\)/);
  assert.match(page,/pendingExpected\.current\.delete\(field\)/);
  assert.match(page,/pendingExpected\.current\.set\(field,/);
  assert.match(page,/blockedFields\.current\.delete\(field\)/);
  // Source still saves other independent fields one-at-a-time.
  assert.match(page,/\: \[selectedField\]/);
  assert.match(page,/lastSavedSnapshot\.current = result\.item/);
  assert.match(page,/itemFieldPatchSchema\.safeParse\(\{ changes, expected, mode: "last-write-wins" \}\)/);
});

test("server validates complete item and zero stock before accepting new unit",()=>{
  const route=readFileSync("apps/api/src/routes-items.ts","utf8");
  assert.match(route,/parse\(itemPatchSchema, \{/);
  assert.match(route,/\.\.\.fieldPatch\.changes/);
  assert.match(route,/addsOnlyPreviouslyInactiveUnits\(before, input\)/);
  assert.match(route,/stock_movements/);
  assert.match(route,/stock_balances/);
  assert.match(route,/quantity_smallest<>0/);
  assert.match(route,/FOR UPDATE/);
  assert.match(route,/columnsToUpdate/);
});
