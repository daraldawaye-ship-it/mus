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
test("zero numeric count automatically uses zeroLocation in UI, unlike positive count",()=>{
  const web=read("apps/web/src/pages/InventoryPages.tsx");
  assert.match(web,/const countIsZero = mode === "adjustment"/);
  assert.match(web,/\.every\(value => \/\^0\*\$\/\.test\(value\.trim\(\)\)\)/);
  assert.match(web,/const zeroCount = mode === "adjustment" && \(zeroLocation \|\| countIsZero\)/);
  assert.match(web,/if \(mode === "adjustment" && !zeroCount\)/);
  assert.match(web,/countedUnits: zeroCount/);
  assert.match(web,/zeroCount \? \{ zeroLocation: true \}/);
  assert.match(web,/mode === "adjustment" && !countIsZero && item\?\.hasExpiry/);
  assert.match(web,/mode === "adjustment" && !countIsZero && \(/);
  assert.match(web,/countIsZero \? "تصفير رصيد الصنف"/);
});
test("backend never requires expiry for zero increase even for expiry-tracked negative stock",()=>{
  const route=read("apps/api/src/routes-inventory.ts");
  const service=read("apps/api/src/services/inventory.ts");
  assert.match(route,/delta > 0n && item\.hasExpiry && !input\.zeroLocation/);
  assert.match(route,/allowUnknownExpiry: input\.zeroLocation && delta > 0n/);
  assert.match(route,/if \(cost <= 0n && !input\.zeroLocation\)/);
  assert.match(service,/input\.kind === "adjustment_surplus"\]\.includes\(input\.kind\) && input\.allowUnknownExpiry/);
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
