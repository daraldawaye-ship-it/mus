import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stockAdjustmentSchema } from "../packages/contracts/src/inventory.ts";
const read=(path:string)=>readFileSync(path,"utf8");
const idempotencyKey="d4514e86-142a-4c6c-9419-28ca1477c842";

test("zero negative balance is valid without shelf composition or any expiry",()=>{
  const parsed=stockAdjustmentSchema.safeParse({
    itemId:15180,locationId:2,documentDate:"2026-11-02",
    unit:1,expiryDate:null,zeroLocation:true,
    countedUnits:{unit1:"0"},expectedQuantitySmallest:"-4",
    idempotencyKey,
  });
  assert.equal(parsed.success,true,parsed.success?"":parsed.error.message);
});
test("entering zero (including all units zero) is a NORMAL physical count, not forced zeroing",()=>{
  const web=read("apps/web/src/pages/InventoryPages.tsx");
  assert.doesNotMatch(web,/countIsZero|zeroCount/);
  assert.match(web,/if \(mode === "adjustment" && !zeroLocation\)/);
  assert.match(web,/countedUnits: zeroLocation\s*\? \{ unit1: "0" \}/);
  assert.match(web,/unit1: fields\.countUnit1 \|\| "0"/);
  assert.match(web,/unit2: fields\.countUnit2 \|\| "0"/);
  assert.match(web,/unit3: fields\.countUnit3 \|\| "0"/);
  assert.match(web,/\.\.\.\(zeroLocation \? \{ zeroLocation: true \} : \{/);
  assert.match(web,/nearestExpiryDate: item\.hasExpiry \? fields\.nearestExpiryDate/);
  assert.match(web,/shelfId: selectedShelf\?\.id \?\? null/);
  assert.match(web,/: "ترحيل تسوية الجرد"\}/);
  assert.doesNotMatch(web,/countedUnits:[\s\S]*?countIsZero|تصفير رصيد الصنف" : "ترحيل تسوية الجرد"/);
});
test("only an explicit zero-button click skips shelf/expiry/composition fields",()=>{
  const web=read("apps/web/src/pages/InventoryPages.tsx");
  assert.match(web,/<Button type="button" variant="secondary"[\s\S]*?void save\(null, true\);[\s\S]*?تصفير الموقع المحدد/);
  assert.match(web,/window\.confirm\([\s\S]*?تصفير رصيد/);
  assert.match(web,/mode === "adjustment" && item && !item\.compositionId/);
  assert.match(web,/mode === "adjustment" && item\?\.hasExpiry/);
  assert.match(web,/label="رف الصنف \(إلزامي\)"/);
  assert.match(web,/label="شهر وسنة أقرب انتهاء في كرت الصنف \(إلزامي\)"/);
  assert.match(web,/if \(mode === "adjustment" && !zeroLocation\)/);
});
test("backend never requires expiry for zero increase even for expiry-tracked negative stock",()=>{
  const route=read("apps/api/src/routes-inventory.ts");
  const service=read("apps/api/src/services/inventory.ts");
  assert.match(route,/delta > 0n && item\.hasExpiry && !input\.zeroLocation/);
  assert.match(route,/allowUnknownExpiry: input\.zeroLocation && delta > 0n/);
  assert.match(route,/if \(cost <= 0n && !input\.zeroLocation\)/);
  assert.ok(service.includes('["purchase", "adjustment_surplus"].includes(input.kind) && input.allowUnknownExpiry'));
  assert.match(route,/assertStockChronology/);
  assert.match(route,/expectedQuantitySmallest/);
  assert.match(route,/await postCommerceJournal/);
  assert.match(route,/zeroLocation\) \{/);
});
test("ordinary nonzero counts retain shelf, expiry and composition validation",()=>{
  const route=read("apps/api/src/routes-inventory.ts");
  assert.match(route,/if \(input\.shelfId == null\)/);
  assert.match(route,/if \(item\.hasExpiry && !input\.nearestExpiryDate\)/);
  assert.match(route,/if \(input\.compositionId === undefined\)/);
});
