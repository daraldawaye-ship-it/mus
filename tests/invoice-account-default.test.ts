import assert from "node:assert/strict";
import test from "node:test";
import { initialInvoiceAccount } from "../apps/web/src/invoice-account-default.ts";

test("purchase invoices never inherit the employee cashbox", () => {
  const cash = { id: 17, name: "Employee cashbox" };
  assert.equal(initialInvoiceAccount("purchase", cash), null);
  assert.equal(initialInvoiceAccount("sale", cash), cash);
  assert.equal(initialInvoiceAccount("sale", null), null);
  assert.equal(initialInvoiceAccount("purchase", null), null);
});
