import assert from "node:assert/strict";
import test from "node:test";
import {
  invoiceLineSchema, invoiceSchema, invoiceLineGross,
  netPurchasePriceFirstUnit,
  groupPurchaseReceiptPrices,
  weightedPurchasePriceFirstUnit,
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

test("purchase weighted card price includes existing on-hand stock", () => {
  // 10 x 1,000 already on hand + 5 x 800 => 14,000 / 15.
  assert.equal(weightedPurchasePriceFirstUnit("1000", "10", "4000", "5", 1), "933.3333");
  // An empty stock position follows the effective newly purchased price.
  assert.equal(weightedPurchasePriceFirstUnit("1000", "0", "4000", "5", 1), "800");
  // All quantities are in smallest units while the card price is per first unit.
  assert.equal(weightedPurchasePriceFirstUnit("1000", "100", "4000", "50", 10), "933.3333");
});

test("free bonus is added to receipt quantity without increasing billed value", () => {
  // Previous 10 x 1,000; buy 5 x 800 plus 5 free => 14,000 / 20.
  assert.equal(weightedPurchasePriceFirstUnit("1000", "10", "4000", "10", 1), "700");
  // Net discounts are included as part of the receipt's actual paid value.
  assert.equal(weightedPurchasePriceFirstUnit("1000", "10", "3500", "10", 1), "675");
});

test("duplicate items are grouped across purchase units, bonuses, and net prices", () => {
  const combined = groupPurchaseReceiptPrices([
    { itemId: 11, quantitySmallest: "2", netTotal: "1600" },
    { itemId: 12, quantitySmallest: "3", netTotal: "90" },
    // Second line is three paid units and one free unit after its discount.
    { itemId: 11, quantitySmallest: "4", netTotal: "2400" },
  ]);
  assert.deepEqual(combined, [
    { itemId: 11, quantitySmallest: "6", netTotal: "4000" },
    { itemId: 12, quantitySmallest: "3", netTotal: "90" },
  ]);
  assert.equal(weightedPurchasePriceFirstUnit(
    "1000", "10", combined[0]!.netTotal, combined[0]!.quantitySmallest, 1,
  ), "875");
  assert.throws(
    () => weightedPurchasePriceFirstUnit("1000", "-1", "4000", "5", 1),
    /سعر أو كمية/,
  );
});
