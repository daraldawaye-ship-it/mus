import assert from "node:assert/strict";
import test from "node:test";
import {
  invoiceLineSchema, invoiceSchema, invoiceLineGross,
  netPurchasePriceFirstUnit,
} from "../packages/contracts/src/commerce.ts";

const base = {
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  kind: "purchase" as "purchase" | "sale",
  documentDate: "2026-11-18",
  currencyId: 1,
  branchId: 1,
  locationId: 1,
  counterpartyAccountId: 1,
  lines: [{
    itemId: 1, unit: 1 as const, quantity: "10",
    bonusQuantity: "5", unitPrice: "1000",
  }],
};

test("purchase bonus leaves billed invoice gross unchanged but changes stock and net unit cost", () => {
  const invoice = invoiceSchema.parse(base);
  const line = invoice.lines[0]!;
  const billed = invoiceLineGross(line.quantity, line.unitPrice!, 2);
  assert.equal(billed, "10000");
  assert.equal((BigInt(line.quantity) + BigInt(line.bonusQuantity ?? "0")).toString(), "15");
  assert.equal(netPurchasePriceFirstUnit(billed, "15", 1), "666.6667");
  assert.equal(netPurchasePriceFirstUnit("10000", "150", 10), "666.6667");
  assert.equal(netPurchasePriceFirstUnit("10000", "10", 1), "1000");
});

test("bonus stays optional for legacy invoices; rejects sales, returns and fractional gifts", () => {
  assert.equal(invoiceLineSchema.parse({ itemId: 1, unit: 1, quantity: "10" }).bonusQuantity, undefined);
  assert.equal(invoiceSchema.safeParse({...base,kind:"sale"}).success, false);
  assert.equal(invoiceSchema.safeParse({...base,lines:[{...base.lines[0],quantity:"-10"}]}).success,false);
  assert.equal(invoiceSchema.safeParse({...base,lines:[{...base.lines[0],bonusQuantity:"1.5"}]}).success,false);
  assert.equal(invoiceSchema.safeParse({...base,lines:[{...base.lines[0],bonusQuantity:"0"}]}).success,true);
});
