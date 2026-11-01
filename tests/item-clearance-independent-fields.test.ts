import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { itemFieldPatchSchema } from "../packages/contracts/src/items.ts";
import { saleClearanceRate } from "../apps/web/src/invoice-clearance-label.ts";
import {classifyClearanceChange} from "../apps/api/src/services/item-clearance-notices.ts";

const page = readFileSync("apps/web/src/pages/ItemsPages.tsx", "utf8");
const editor = page.slice(page.indexOf("function ItemEditor({"), page.indexOf("function UnitPreview({"));
const contracts = readFileSync("packages/contracts/src/items.ts", "utf8");
const route = readFileSync("apps/api/src/routes-items.ts", "utf8");

test("each clearance field is independently accepted with previously empty values",()=>{
  const patches = [
    {changes:{commissionRate:"10"},expected:{commissionRate:"0"}},
    {changes:{clearanceFrom:"2026-11-02"},expected:{clearanceFrom:null}},
    {changes:{clearanceTo:"2026-11-30"},expected:{clearanceTo:null}},
    {changes:{clearanceFrom:null},expected:{clearanceFrom:"2026-11-02"}},
  ];
  for(const patch of patches)
    assert.equal(itemFieldPatchSchema.safeParse(patch).success,true,JSON.stringify(patch));
  const validation = contracts.slice(contracts.indexOf("function validateNames("),
    contracts.indexOf("export const itemSchema"));
  assert.doesNotMatch(validation,/حدد بداية ونهاية فترة التصريف لتفعيل العمولة/);
  assert.doesNotMatch(validation,/تاريخ نهاية التصريف لا يسبق بدايته/);
});

test("no sale commission until all three values meet the inclusive interval",()=>{
  const item = {active:true, commissionRate:"10",clearanceFrom:null as string|null,clearanceTo:null as string|null};
  assert.equal(saleClearanceRate(item,"2026-11-15"),null);
  item.clearanceFrom="2026-11-01";
  assert.equal(saleClearanceRate(item,"2026-11-15"),null);
  item.clearanceTo="2026-11-30";
  assert.equal(saleClearanceRate(item,"2026-11-15"),"10");
  assert.equal(saleClearanceRate(item,"2026-11-01"),"10");
  assert.equal(saleClearanceRate(item,"2026-12-01"),null);
  item.clearanceTo="2026-10-10";
  assert.equal(saleClearanceRate(item,"2026-11-15"),null);
  assert.equal(classifyClearanceChange(
    {commissionRate:"0",clearanceFrom:null,clearanceTo:null},item,"2026-11-15"),
    "ITEM_CLEARANCE_UPDATED");
});

test("editor autosaves changes without three-field prerequisite and handles stale values",()=>{
  assert.match(editor,/onChange=\{\(event\) => edit\("commissionRate", event\.target\.value\)\}/);
  assert.match(editor,/onChange=\{\(event\) => edit\("clearanceFrom", event\.target\.value\)\}/);
  assert.match(editor,/onChange=\{\(event\) => edit\("clearanceTo", event\.target\.value\)\}/);
  assert.match(editor,/onBlurCapture=\{event =>/);
  assert.match(editor,/setConflictDetails\(\{latest:latest\.item,fields:conflicting\}\)/);
  assert.match(editor,/save\(undefined, conflictDetails\.latest\)/);
  assert.match(editor,/body:\{changes,expected\}/);
  assert.match(editor,/لم نحذف|تعديلاتك باقية/);
  assert.match(editor,/التصريف غير مفعّل، ولا تُحسب أي عمولة/);
  assert.match(route,/تغيّرت قيمة حقل/);
  assert.doesNotMatch(editor,/توجد نسخة أحدث من هذا الصنف\. تعديلاتك باقية هنا/);
});
