import {readFileSync} from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {canColorColumnValue,columnValueColors,columnValueTone,savedValueColor} from "../apps/web/src/column-value-colors.ts";

test("four named accents plus a genuine no-color default; saved legacy hues resolve",()=>{
  assert.equal(columnValueTone(null),undefined);
  assert.equal(columnValueTone("#777777"),undefined);
  assert.deepEqual(columnValueColors.map(option=>columnValueTone(option.value)),["green","orange","red","blue"]);
  assert.equal(columnValueTone("#ffff00"),"orange");
  assert.equal(columnValueTone("#66ff70"),"green");
  assert.equal(columnValueTone("#5276bb"),"blue");
  assert.equal(savedValueColor("item-options-list",{id:"stock",width:48,visible:true,color:null}),null);
});
test("interactive fields and actions never receive a value accent",()=>{
  for(const id of ["choice","reserve","purchaseFactor","minOrderQuantity","orderAlertQuantity","orderStoppedUntil","reviewed","purchaseNotes"])
    assert.equal(canColorColumnValue("item-options-list",id),false);
  assert.equal(canColorColumnValue("journal-lines","document"),false);
  assert.equal(savedValueColor("item-options-list",{id:"choice",width:48,visible:true,color:"#4389e9"}),null);
  assert.equal(canColorColumnValue("item-options-list","stock"),true);
  assert.equal(canColorColumnValue("journal-lines","credit"),true);
});
test("D13 accents stop at cell content and item mobile badges attach to values rather than labels",()=>{
  const table=readFileSync(new URL("../apps/web/src/InteractiveColumnsTable.tsx",import.meta.url),"utf8");
  const mobile=readFileSync(new URL("../apps/web/src/pages/ItemOptionsListPage.tsx",import.meta.url),"utf8");
  const page=readFileSync(new URL("../apps/web/src/pages/TableColumnDefaultsPage.tsx",import.meta.url),"utf8");
  assert.doesNotMatch(table,/<th[^>]*backgroundColor:|borderInlineStartColor:/);
  assert.match(table,/colorValue===false \? undefined : valueTones.get\(key\)/);
  assert.match(mobile,/<bdi data-column-value-tone=\{itemValueTone\("stock"\)\}/);
  assert.doesNotMatch(mobile,/itemValueTone\("(choice|reserve|reviewed)"\)/);
  assert.match(page,/<option value="">بدون لون<\/option>/);
  assert.doesNotMatch(page,/type="color"/);
});
