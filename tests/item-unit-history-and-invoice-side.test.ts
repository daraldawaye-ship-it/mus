import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addsOnlyPreviouslyInactiveUnits } from "../apps/api/src/services/item-unit-history.ts";

const original = {
  unit1Name: "باكت", unit2Name: "", unit3Name: "",
  factor2: 1, factor3: 1, hasExpiry: true,
};

test("allow adding a previously unused second or third unit without modifying an existing unit", () => {
  const withSecond = { ...original, unit2Name: "حبة", factor2: 10 };
  assert.equal(addsOnlyPreviouslyInactiveUnits(original, withSecond), true);
  assert.equal(addsOnlyPreviouslyInactiveUnits(original, { ...original, unit2Name: "حبة" }), true);
  assert.equal(addsOnlyPreviouslyInactiveUnits(withSecond,
    { ...withSecond, unit3Name: "شريط", factor3: 2 }), true);
  assert.equal(addsOnlyPreviouslyInactiveUnits(withSecond,
    { ...withSecond, unit3Name: "شريط" }), true);
});

test("do not rewrite units used by historical movements, even if current stock is zero", () => {
  const withSecond = { ...original, unit2Name: "حبة", factor2: 10 };
  const allUnits = { ...withSecond, unit3Name: "شريط", factor3: 2 };
  assert.equal(addsOnlyPreviouslyInactiveUnits(withSecond,
    { ...withSecond, factor2: 12 }), false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(withSecond,
    { ...withSecond, unit2Name: "كرتون" }), false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(withSecond,
    { ...withSecond, unit1Name: "علبة" }), false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(withSecond,
    { ...withSecond, hasExpiry: false }), false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(allUnits,
    { ...allUnits, factor3: 5 }), false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(allUnits,
    { ...allUnits, unit3Name: "" }), false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(allUnits,
    { ...allUnits, factor2: 1 }), false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(original,
    { ...original, factor3: 5, unit3Name: "حبة" }), false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(original,
    { ...original, factor2: 10 }), false);
});

test("item routes check every authoritative stock batch before activation", () => {
  const routes = readFileSync("apps/api/src/routes-items.ts", "utf8");
  assert.match(routes, /addsOnlyPreviouslyInactiveUnits\(before, input\)/);
  assert.match(routes, /FROM stock_balances[\s\S]*?quantity_smallest<>0/);
  assert.match(routes, /SELECT 1 FROM stock_movements/);
  assert.match(routes, /FOR UPDATE/);
});

test("invoice side reports do not permit choosing another employee", () => {
  const routes = readFileSync("apps/api/src/routes-commerce.ts", "utf8");
  const service = readFileSync("apps/api/src/services/my-cashbox-transfers.ts", "utf8");
  const ui = readFileSync("apps/web/src/InvoiceSideOverview.tsx", "utf8");
  assert.match(routes, /sales\/my-cashbox-transfers/);
  assert.match(routes, /listMyCashboxTransfers\(client, companyId, actor\(req\)\.id\)/);
  assert.match(service, /WHERE company_id=\$1 AND user_id=\$2 AND active/);
  assert.match(service, /kind IN \('pouch','electronic'\)/);
  assert.match(service, /created_at >= \$3::timestamptz AND created_at <= \$4::timestamptz/);
  assert.match(service, /kind='close'/);
  assert.match(service, /GREATEST\(variance_amount,0\)/);
  assert.match(service, /GREATEST\(-variance_amount,0\)/);
  assert.match(service, /24 \* millisecondsPerHour/);
  assert.match(service, /14 \* millisecondsPerHour/);
  assert.match(ui, /attendance\/currently-present/);
  assert.match(ui, /ترحيلاتي إلى الحافظة/);
  assert.match(ui, /المحضرون حاليًا/);
  assert.match(ui, /العجز والزيادة عند الإغلاق/);
  assert.match(ui, /آخر 24 ساعة/);
  assert.match(ui, /آخر 3 أيام/);
});
