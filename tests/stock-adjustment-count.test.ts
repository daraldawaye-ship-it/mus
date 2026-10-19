import assert from "node:assert/strict";
import test from "node:test";
import { countedStockSmallest, stockAdjustmentSchema } from "../packages/contracts/src/inventory.ts";

test("physical count supports all three unit levels without double counting", () => {
  // One carton has 12 boxes, and a box has 10 pieces.
  assert.equal(
    countedStockSmallest({ unit1: "2", unit2: "3", unit3: "4" }, { factor2: 12, factor3: 10 }),
    274n,
  );
});
test("two packs plus two loose ampoules with 3 per pack reconcile to eight pieces", () => {
  assert.equal(
    countedStockSmallest({ unit1: "2", unit2: "2" }, { factor2: 3, factor3: 1 }),
    8n,
  );
});

test("reconciliation accepts negative previous stock but never negative counted units", () => {
  const entry = {
    documentDate: "2026-10-19",
    itemId: 1,
    locationId: 1,
    countedUnits: { unit1: "2", unit2: "2" },
    expectedQuantitySmallest: "-3",
    unit: 1,
    shelfId: 1,
    nearestExpiryDate: "2027-11-01",
    idempotencyKey: "dd3b5336-b38f-4fd4-9fd6-6e3b67dba20b",
  };
  const valid = stockAdjustmentSchema.safeParse(entry);
  assert.equal(valid.success, true, valid.success ? "" : valid.error.message);
  if (valid.success) assert.equal(valid.data.expectedQuantitySmallest, "-3");
  const bad = stockAdjustmentSchema.safeParse({
    ...entry, countedUnits: { unit1: "-2", unit2: "2" },
  });
  assert.equal(bad.success, false);
});

test("physical count supports only two or only one configured units", () => {
  assert.equal(countedStockSmallest({ unit1: "2", unit2: "4" }, { factor2: 10, factor3: 1 }), 24n);
  assert.equal(countedStockSmallest({ unit1: "7" }, { factor2: 1, factor3: 1 }), 7n);
});
test("three unit quantities retain exact precision beyond JavaScript's safe integer", () => {
  assert.equal(
    countedStockSmallest({ unit1: "999999999999999999", unit2: "4", unit3: "7" }, { factor2: 12, factor3: 10 }),
    119999999999999999927n,
  );
});
test("stock adjustment accepts all unit counts and independent nearest expiry", () => {
  const result = stockAdjustmentSchema.safeParse({
    documentDate: "2026-10-15",
    itemId: 1,
    locationId: 2,
    countedUnits: { unit1: "2", unit2: "3", unit3: "4" },
    expectedQuantitySmallest: "0",
    unit: 1,
    expiryDate: "2027-01-31",
    nearestExpiryDate: "2026-11-30",
    unitCostBase: "100",
    description: "count",
    idempotencyKey: "dd3b5336-b38f-4fd4-9fd6-6e3b67dba20b",
  });
  assert.equal(result.success, true, result.success ? "" : result.error.message);
});
test("stock adjustments reject submissions without a physical count", () => {
  const result = stockAdjustmentSchema.safeParse({
    documentDate: "2026-10-15",
    itemId: 1,
    locationId: 2,
    expectedQuantitySmallest: "0",
    unit: 1,
    expiryDate: null,
    unitCostBase: "100",
    idempotencyKey: "dd3b5336-b38f-4fd4-9fd6-6e3b67dba20b",
  });
  assert.equal(result.success, false);
});
