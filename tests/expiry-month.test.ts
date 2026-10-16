import assert from "node:assert/strict";
import test from "node:test";
import { expiryMonth, monthStartDate } from "../apps/web/src/ExpiryMonthField.tsx";

test("month/year expiry entry generates the first calendar day", () => {
  assert.equal(monthStartDate("2027-10"), "2027-10-01");
  assert.equal(monthStartDate("2028-02"), "2028-02-01");
  assert.equal(monthStartDate("0001-01"), "0001-01-01");
  assert.equal(monthStartDate("2027-00"), null);
  assert.equal(monthStartDate("2027-13"), null);
  assert.equal(monthStartDate("0000-01"), null);
  assert.equal(monthStartDate("2027-02-15"), null);
  assert.equal(monthStartDate(""), null);
});

test("legacy expiry dates display by month without silently changing stored day", () => {
  const old = "2027-10-31";
  assert.equal(expiryMonth(old), "2027-10");
  assert.equal(old, "2027-10-31");
  assert.equal(expiryMonth("2027-10-01"), "2027-10");
  assert.equal(expiryMonth(null), "");
  assert.equal(expiryMonth(undefined), "");
});
