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
