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

test("configured purchase header account never changes the supplier and leaves sale cashbox intact", () => {
  const cash = { id: 17, name: "Employee cashbox" };
  const selected = { id: 22, name: "Configured purchase account" };
  assert.equal(initialInvoiceAccount("purchase", cash, selected), selected);
  assert.equal(initialInvoiceAccount("sale", cash, selected), cash);
  assert.equal(initialInvoiceAccount("purchase", cash, null), null);
});
