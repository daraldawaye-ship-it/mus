import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { itemOptionsPresetFiltersSchema } from "../packages/contracts/src/item-options-presets.ts";
import { itemFactorSchema } from "../packages/contracts/src/items.ts";

const read = (path: string) => readFileSync(path, "utf8");

test("new saved factor and adequacy filters preserve existing presets", () => {
  const old = {
    q: "", active: "active", stockMin: "1", stockMax: "1",
    reserveMin: "", reserveMax: "", monthMin: "", monthMax: "",
    fourMonthsMin: "", fourMonthsMax: "", allTimeMin: "", allTimeMax: "",
    previousYearMin: "", previousYearMax: "", coverageMin: "", coverageMax: "",
    excludeZero: false, useReserve: true, sortBy: "allTime", sortDir: "desc",
  };
  const previous = itemOptionsPresetFiltersSchema.parse(old);
  for (const key of [
    "purchaseFactorMin", "purchaseFactorMax",
    "reserveCoverageMin", "reserveCoverageMax",
    "purchaseFactorCoverageMin", "purchaseFactorCoverageMax",
  ] as const) assert.equal(previous[key], "");
  const next = itemOptionsPresetFiltersSchema.parse({
    ...old, purchaseFactorMin: "1", purchaseFactorMax: "100",
    reserveCoverageMin: "-10", purchaseFactorCoverageMax: "9999",
    sortBy: "purchaseFactorCoverage",
  });
  assert.equal(next.purchaseFactorCoverageMax, "9999");
  assert.equal(next.sortBy, "purchaseFactorCoverage");
});

test("purchase factor is strictly positive integral, and guarded row updates are non-stock", () => {
  assert.equal(itemFactorSchema.parse(1), 1);
  assert.equal(itemFactorSchema.parse(100), 100);
  assert.throws(() => itemFactorSchema.parse(0));
  assert.throws(() => itemFactorSchema.parse(-1));
  assert.throws(() => itemFactorSchema.parse(1.5));
  const api = read("apps/api/src/routes-item-options-list.ts");
  const route = api.split('router.patch("/companies/:companyId/items/:itemId/purchase-factor"')[1]
    ?.split('router.get("/companies/:companyId/item-options-list"')[0] ?? "";
  assert.match(route, /assertDirectoryAccess\(listPage, "edit"\)/);
  assert.match(route, /revision=revision\+1/);
  assert.match(route, /audit\(/);
  assert.doesNotMatch(route, /stock_movements|stock_balances|invoice_lines/);
});

test("reserve and purchase factor coverage reuse existing sales-rate windows", () => {
  const coverage = read("apps/api/src/services/item-coverage.ts");
  assert.match(coverage, /i\.reserve_quantity \* coverage_rate\.days \/ coverage_rate\.sales/);
  assert.match(coverage, /i\.purchase_factor \* coverage_rate\.days \/ coverage_rate\.sales/);
  assert.match(coverage, /coverage_stock\.stock_showroom/);
  assert.match(coverage, /coverage_stock\.stock_warehouse/);
  const api = read("apps/api/src/routes-item-options-list.ts");
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  for (const key of ["purchaseFactorMin", "purchaseFactorMax",
    "reserveCoverageMin", "reserveCoverageMax",
    "purchaseFactorCoverageMin", "purchaseFactorCoverageMax"]) {
    assert.ok(api.includes(key), "server filter "+key);
    assert.ok(ui.includes(key), "UI filter "+key);
  }
  for (const sort of ["purchaseFactor", "reserveCoverage", "purchaseFactorCoverage"]) {
    assert.ok(api.includes(sort), "server sort "+sort);
    assert.ok(ui.includes(sort), "UI sort "+sort);
  }
  assert.ok(ui.includes("ItemPurchaseFactorQuickEdit"));
  assert.match(ui, /row\.reserveCoverageDays/);
  assert.match(ui, /row\.purchaseFactorCoverageDays/);
});

test("item-options replenishment uses the applied coverage target and rounds up to purchase lots", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const coverage = read("apps/api/src/services/item-coverage.ts");
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  assert.match(api, /requiredPurchaseQuantitiesToPage\(/);
  assert.match(api, /options\.coverageMax \?\? "30"/);
  assert.match(api, /requiredPurchaseQuantity: requiredQuantities\.get\(row\.id\)/);
  assert.match(coverage, /coverage_rate\.sales \* greatest\(\$3::numeric,0\) \/ coverage_rate\.days/);
  assert.match(coverage, /CASE WHEN \$4::boolean THEN i\.reserve_quantity/);
  assert.match(coverage, /- coverage_rate\.quantity/);
  assert.match(coverage, /ceil\(greatest\(0::numeric/);
  assert.match(coverage, /lcm\(greatest\(i\.purchase_factor::bigint,1\)/);
  assert.match(ui, /monthMin: params\.get\("monthMin"\) \?\? "1"/);
  assert.match(ui, /coverageMax: params\.get\("coverageMax"\) \?\? "2"/);
  assert.match(ui, /<input type="text" inputMode="decimal"/);
  assert.doesNotMatch(ui, /<input type="number" step="any"/);
  assert.match(ui, /colSpan=\{17\}/);
  assert.match(ui, /row\.requiredPurchaseQuantity/);
});


test("monthly sold quantities come directly from precomputed ranking tables", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const css = read("apps/web/src/styles.css");
  assert.match(api, /assertItemSaleRankingsReady\(client\)/);
  assert.match(api, /LEFT JOIN item_sale_rankings sale_rank/);
  assert.match(api, /LEFT JOIN staged_item_sale_rankings staged_rank/);
  assert.match(api, /sale_rank\.net_sale_quantity/);
  assert.match(api, /staged_rank\.net_sale_quantity/);
  assert.match(api, /sale_rank\.net_sale_invoices/);
  assert.match(api, /staged_rank\.net_sale_invoices/);
  assert.match(api, /saleQuantityMonth: String\(row\.sale_quantity_month\)\.replace\(/);
  assert.match(ui, /row\.saleQuantityMonth/);
  assert.match(ui, /stockMin: params\.get\("stockMin"\) \?\? "", stockMax: params\.get\("stockMax"\) \?\? ""/);
  assert.match(ui, /monthMin: "1", coverageMax: "2"/);
  assert.match(ui, /<th scope="col" className="item-options-choice-cell">اختيار<\/th>/);
  assert.doesNotMatch(ui, /<th scope="col">اختيار مؤقت<\/th>/);
  assert.doesNotMatch(ui, /<span>\{temporarySelection\.pendingIds\.has\(row\.itemId\) \? "حفظ/);
  assert.match(css, /item-options-reserve-col/);
  assert.match(css, /item-options-choice-col/);
});

test("item-options register uses compact widths for all 17 columns", () => {
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const css = read("apps/web/src/styles.css");
  const columns = ui.slice(ui.indexOf('<colgroup>'), ui.indexOf('</colgroup>'));
  assert.equal((columns.match(/<col className=/g) ?? []).length, 17);
  assert.doesNotMatch(columns, /span=\{9\}/);
  assert.match(css, /item-options-desktop-table > table \{\s*min-width: 1410px/);
  assert.doesNotMatch(css, /item-options-desktop-table > table \{\s*min-width: 1850px/);
  assert.match(css, /col\.item-options-reserve-col,\s*\.item-options-desktop-table col\.item-options-purchase-factor-col \{ width: 116px; \}/);
  assert.match(css, /item-options-choice-col \{ width: 38px; \}/);
  assert.match(css, /item-options-month-quantity-col \{ width: 77px; \}/);
  assert.match(css, /item-options-factor-coverage-col \{ width: 75px; \}/);
});

test("item-options purchase price and projected sufficiency use whole first units", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const coverage = read("apps/api/src/services/item-coverage.ts");
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const css = read("apps/web/src/styles.css");
  assert.match(api, /i\.purchase_price AS purchase_price/);
  assert.match(api, /JOIN company_currencies currency/);
  assert.match(api, /purchaseCurrencyCode: String\(row\.currency_code\)/);
  assert.match(api, /requiredPurchaseValue: requiredQuantities\.get\(row\.id\)\?\.requiredPurchaseValue/);
  assert.match(api, /coverageWithRequiredDays: requiredQuantities\.get\(row\.id\)\?\.coverageWithRequiredDays/);
  assert.match(coverage, /lcm\(greatest\(i\.purchase_factor::bigint,1\)/);
  assert.match(coverage, /i\.factor2::bigint \* i\.factor3::bigint/);
  assert.match(coverage, /requested\.quantity_smallest \/ purchase_lot\.first_unit_smallest/);
  assert.match(coverage, /round\(i\.purchase_price::numeric/);
  assert.match(coverage, /coverage_rate\.quantity \+ requested\.quantity_smallest/);
  for (const label of [
    "الكمية المطلوبة (الوحدة الأولى)",
    "سعر الشراء الافتراضي (الوحدة الأولى)",
    "قيمة المطلوب",
    "الكفاية مع المطلوب"
  ]) assert.ok(ui.includes(label), label);
  assert.match(ui, /row\.purchaseCurrencyCode/);
  assert.match(ui, /row\.coverageWithRequiredDays/);
  assert.match(css, /item-options-purchase-price-col/);
  assert.match(css, /item-options-required-value-col/);
  assert.match(css, /item-options-coverage-with-required-col/);
});

test("rounded first-unit quantities are also exact multiples of smallest-unit purchase lots", () => {
  const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
  const expected = (shortageSmallest: bigint, firstUnitSmallest: bigint, purchaseFactor: bigint) => {
    const lot = firstUnitSmallest / gcd(firstUnitSmallest, purchaseFactor) * purchaseFactor;
    const smallest = ((shortageSmallest + lot - 1n) / lot) * lot;
    return {firstUnits: smallest / firstUnitSmallest, smallest};
  };
  for (const [shortage, first, factor] of [
    [17n, 12n, 12n], [17n, 12n, 5n], [17n, 100n, 1n],
    [101n, 100n, 6n], [0n, 12n, 12n]
  ] as const) {
    const x = expected(shortage, first, factor);
    assert.equal(x.smallest % factor, 0n);
    assert.equal(x.smallest % first, 0n);
    assert.ok(x.smallest >= shortage);
    if (shortage > 0n) assert.ok(x.firstUnits >= 1n);
  }
  assert.deepEqual(expected(17n,12n,12n), {firstUnits:2n,smallest:24n});
  assert.deepEqual(expected(17n,100n,1n), {firstUnits:1n,smallest:100n});
});
