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
