import assert from "node:assert/strict";
import test from "node:test";
import { enteredMonthStart, expiryDigits, expiryMonth, monthIsComplete, monthShouldAdvance, monthStartDate } from "../apps/web/src/ExpiryMonthField.tsx";
import { formatWholeMoney } from "../apps/web/src/format-money.ts";

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

test("numeric expiry entry accepts Arabic digits and advances at an unambiguous month", () => {
  assert.equal(expiryDigits("١٢"), "12");
  assert.equal(expiryDigits("۰۷"), "07");
  assert.equal(expiryDigits(" 12 / 2028 "), "122028");
  for (const month of ["2","9","01","09","10","11","12"])
    assert.equal(monthShouldAdvance(month),true,month);
  for (const month of ["","0","1","00","13"])
    assert.equal(monthShouldAdvance(month),false,month);
  assert.equal(monthIsComplete("1"),true);
  assert.equal(enteredMonthStart("1","2028"),"2028-01-01");
  assert.equal(enteredMonthStart("12","2029"),"2029-12-01");
  assert.equal(enteredMonthStart("13","2029"),null);
  assert.equal(enteredMonthStart("12",""),null);
  assert.equal(enteredMonthStart("12","29"),null);
  assert.equal(enteredMonthStart("01","0000"),null);
});

test("compact item history prices display whole amounts without unsafe number conversion", () => {
  assert.equal(formatWholeMoney("385.00"),"385");
  assert.equal(formatWholeMoney("385.49"),"385");
  assert.equal(formatWholeMoney("385.50"),"386");
  assert.equal(formatWholeMoney("13500.00"),"13,500");
  assert.equal(formatWholeMoney("12345678901234567890.99"),"12,345,678,901,234,567,891");
  assert.equal(formatWholeMoney("-1500.99"),"-1,501");
  assert.equal(formatWholeMoney("0.49"),"0");
  assert.equal(formatWholeMoney(null),"—");
});
