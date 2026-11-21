import assert from "node:assert/strict";
import { test } from "node:test";
import { compactItemDraft, compactItemFieldPatch, stepCompactItemValue } from "../apps/web/src/work-panel-compact-card.ts";

const item={reserveQuantity:"12",purchaseFactor:6,minOrderQuantity:"1",orderAlertQuantity:null,reviewed:false};
test("compact card only patches deliberately changed canonical fields with field-level compare-and-set",()=>{
  const draft=compactItemDraft(item);
  assert.deepEqual(compactItemFieldPatch(item,draft),{payload:null});
  assert.deepEqual(compactItemFieldPatch(item,{...draft,orderAlertQuantity:"٠",reviewed:true}),{
    payload:{changes:{orderAlertQuantity:"0",reviewed:true},expected:{orderAlertQuantity:null,reviewed:false}},
  });
  const enabled={...item,orderAlertQuantity:"0"};
  assert.deepEqual(compactItemFieldPatch(enabled,{...compactItemDraft(enabled),orderAlertQuantity:""}),{
    payload:{changes:{orderAlertQuantity:null},expected:{orderAlertQuantity:"0"}},
  });
  assert.deepEqual(compactItemFieldPatch(item,{...draft,reserveQuantity:"١٢",purchaseFactor:"06"}),{payload:null});
  assert.match(compactItemFieldPatch(item,{...draft,reserveQuantity:"-1"}).error??"",/كمية احتياط/);
  assert.match(compactItemFieldPatch(item,{...draft,minOrderQuantity:"0"}).error??"",/أقل كمية طلب/);
  assert.match(compactItemFieldPatch(item,{...draft,purchaseFactor:"0"}).error??"",/عامل وحدة الشراء/);
});

test("compact card steppers preserve integers, nullable blank, safe bounds, and high precision",()=>{
  assert.equal(stepCompactItemValue("orderAlertQuantity","",1),"0");
  assert.equal(stepCompactItemValue("orderAlertQuantity","",-1),"");
  assert.equal(stepCompactItemValue("orderAlertQuantity","0",-1),"0");
  assert.equal(stepCompactItemValue("reserveQuantity","٩٠٠٧١٩٩٢٥٤٧٤٠٩٩٣",1),"9007199254740994");
  assert.equal(stepCompactItemValue("minOrderQuantity","1",-1),"1");
  assert.equal(stepCompactItemValue("minOrderQuantity","2147483647",1),"2147483647");
  assert.equal(stepCompactItemValue("purchaseFactor","1000000",1),"1000000");
});
