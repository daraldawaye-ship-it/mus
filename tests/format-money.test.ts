import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney, formatWholeMoney } from "../apps/web/src/format-money.ts";

test("money display groups thousands exactly without floating point", () => {
  assert.equal(formatMoney("1000"), "1,000");
  assert.equal(formatMoney("1200000.50"), "1,200,000.50");
  assert.equal(formatMoney("-1234567.000001"), "-1,234,567.000001");
  assert.equal(formatMoney("9999999999999999999999.123456"), "9,999,999,999,999,999,999,999.123456");
  assert.equal(formatMoney("0"), "0");
  assert.equal(formatMoney("0.000000"), "0.000000");
  assert.equal(formatMoney("—"), "—");
  assert.equal(formatMoney(""), "");
  assert.equal(formatMoney(null), "—");
  assert.equal(formatMoney("1234/5"), "1234/5");
});

test("receipt register whole-rial display removes trailing fractions and preserves negative signs", () => {
  assert.equal(formatWholeMoney("200.000000"), "200");
  assert.equal(formatWholeMoney("-200.000000"), "-200");
  assert.equal(formatWholeMoney("-1000.000000"), "-1,000");
  assert.equal(formatWholeMoney("1234567.000000"), "1,234,567");
  assert.equal(formatWholeMoney("950.40"), "950");
  assert.equal(formatWholeMoney("-950.60"), "-951");
  assert.equal(formatWholeMoney("0.000000"), "0");
  assert.equal(formatWholeMoney(null), "—");
});
