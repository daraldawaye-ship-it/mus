import test from "node:test";
import assert from "node:assert/strict";
import {
  itemOptionsPresetCreateSchema,
  itemOptionsPresetFiltersSchema,
} from "../packages/contracts/src/item-options-presets.ts";

const filters = {
  q: "", active: "active",
  stockMin: "", stockMax: "", monthMin: "", monthMax: "",
  fourMonthsMin: "", fourMonthsMax: "", allTimeMin: "", allTimeMax: "",
  coverageMin: "", coverageMax: "",
  excludeZero: false, useReserve: true,
  sortBy: "allTime", sortDir: "desc",
};

test("named item options preserve selected columns for company-shared presets", () => {
  const columns = ["name", "stock", "requiredPurchaseQuantity", "coverage"];
  const result = itemOptionsPresetCreateSchema.parse({
    name: "احتياجات الشراء",
    filters: { ...filters, visibleColumns: columns },
  });
  assert.deepEqual(result.filters.visibleColumns, columns);
});

test("older saved filters without columns remain valid and do not reset visibility", () => {
  const result = itemOptionsPresetFiltersSchema.parse(filters);
  assert.equal(result.visibleColumns, undefined);
  assert.equal(result.excludeOrderStopped, true);
  assert.equal(result.excludeOrderDrafts, true);
});

test("invalid, repeated or empty visible columns cannot be saved", () => {
  for (const columns of [
    [],
    ["name", "name"],
    ["name", "not-a-real-column"],
  ]) {
    const result = itemOptionsPresetCreateSchema.safeParse({
      name: "اختبار", filters: { ...filters, visibleColumns: columns },
    });
    assert.equal(result.success, false);
  }
});

test("purchase price, required quantity and purchase note column are saved in named presets", () => {
  const result = itemOptionsPresetCreateSchema.parse({
    name: "مشتريات حسب الحاجة",
    filters: {
      ...filters,
      purchasePriceMin: "10.25", purchasePriceMax: "999.125",
      requiredPurchaseQuantityMin: "1", requiredPurchaseQuantityMax: "250",
      reserveCoverageMin: "0", reserveCoverageMax: "30",
      purchaseFactorCoverageMin: "0", purchaseFactorCoverageMax: "90",
      visibleColumns: ["name", "purchaseNotes", "requiredPurchaseQuantity", "purchasePrice"],
    },
  });
  assert.equal(result.filters.purchasePriceMin, "10.25");
  assert.equal(result.filters.purchasePriceMax, "999.125");
  assert.equal(result.filters.requiredPurchaseQuantityMin, "1");
  assert.equal(result.filters.requiredPurchaseQuantityMax, "250");
  assert.deepEqual(result.filters.visibleColumns, [
    "name", "purchaseNotes", "requiredPurchaseQuantity", "purchasePrice",
  ]);
});

test("older presets without the four new ranges remain valid with unbounded defaults", () => {
  const parsed = itemOptionsPresetFiltersSchema.parse(filters);
  assert.equal(parsed.purchasePriceMin, "");
  assert.equal(parsed.purchasePriceMax, "");
  assert.equal(parsed.requiredPurchaseQuantityMin, "");
  assert.equal(parsed.requiredPurchaseQuantityMax, "");
});

test("invalid price or required quantity ranges are not accepted in presets", () => {
  for (const invalid of ["12x", "1.1234567"]) {
    assert.equal(itemOptionsPresetCreateSchema.safeParse({
      name: "اختبار", filters: { ...filters, purchasePriceMin: invalid },
    }).success, false);
    assert.equal(itemOptionsPresetCreateSchema.safeParse({
      name: "اختبار", filters: { ...filters, requiredPurchaseQuantityMax: invalid },
    }).success, false);
  }
});
