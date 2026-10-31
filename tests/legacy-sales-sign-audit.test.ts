import assert from "node:assert/strict";
import test from "node:test";
import { classifyLegacySaleSign } from "../apps/api/src/services/legacy-sales-sign-audit.ts";

test("legacy signed stock movements are opposite from invoice sale quantities", () => {
  assert.equal(classifyLegacySaleSign("-5","5"),"converted");
  assert.equal(classifyLegacySaleSign("5","-5"),"converted");
  assert.equal(classifyLegacySaleSign("-5","-5"),"unconverted");
  assert.equal(classifyLegacySaleSign("5","5"),"unconverted");
});

test("fractional quantities classify by sign without rounding", () => {
  assert.equal(classifyLegacySaleSign("-0.04","-1"),"unconverted");
  assert.equal(classifyLegacySaleSign("-0.04","1"),"converted");
  assert.equal(classifyLegacySaleSign("0.000001","-1"),"converted");
});

test("invalid or zero source quantities are not silently considered correctable", () => {
  for (const value of ["", "null", "0", "-0.000000", "Infinity", "NaN"]) {
    assert.equal(classifyLegacySaleSign(value,"-1"),"invalid");
  }
});

import { assertLegacy127Scope } from "../apps/api/src/services/legacy-sales-127-repair.ts";

test("127 invoice repair scope rejects any unexpected batch", () => {
  const scope = {companyId:2,sourceSystem:"dar-aldawa-legacy-2026-10",importDayUtc:"2026-10-30",importedInvoices:127,sales:126,purchasesUnchanged:1,saleLines:560,corrected:0,remaining:126};
  assert.doesNotThrow(() => assertLegacy127Scope(scope));
  assert.throws(() => assertLegacy127Scope({...scope,importedInvoices:128}));
});
