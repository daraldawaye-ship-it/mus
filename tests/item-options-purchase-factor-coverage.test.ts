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
  assert.match(coverage, /i\.purchase_factor \* greatest\(i\.factor2::numeric \* i\.factor3::numeric,1\)/);
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
  assert.match(api, /options\.coverageWithReserveMax \?\? "30"/);
  assert.match(api, /requiredPurchaseQuantity: requiredQuantities\.get\(row\.id\)/);
  assert.match(coverage, /coverage_rate\.sales \* greatest\(\$3::numeric,0\) \/ coverage_rate\.days/);
  assert.match(coverage, /CASE WHEN \$4::boolean THEN i\.reserve_quantity/);
  assert.match(coverage, /- coverage_rate\.quantity/);
  assert.match(coverage, /ceil\(greatest\(0::numeric/);
  assert.match(coverage, /greatest\(i\.purchase_factor::bigint,1\)::numeric/);
  assert.match(ui, /monthMin: params\.get\("monthMin"\) \?\? "1"/);
  assert.match(ui, /coverageWithReserveMax: params\.get\("coverageWithReserveMax"\) \?\? "1"/);
  assert.match(ui, /<input type="text" inputMode="decimal"/);
  assert.doesNotMatch(ui, /<input type="number" step="any"/);
  assert.match(ui, /colSpan=\{visibleColumns\.length\}/);
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
  assert.match(ui, /monthMin: "1", yearMin: "2", coverageWithReserveMax: "1"/);
  assert.match(ui, /<th scope="col" className="item-options-choice-cell">اختيار<\/th>/);
  assert.doesNotMatch(ui, /<th scope="col">اختيار مؤقت<\/th>/);
  assert.doesNotMatch(ui, /<span>\{temporarySelection\.pendingIds\.has\(row\.itemId\) \? "حفظ/);
  assert.match(css, /item-options-reserve-col/);
  assert.match(css, /item-options-choice-col/);
});

test("item-options register retains compact widths for all 19 columns", () => {
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const css = read("apps/web/src/styles.css");
  const columns = ui.slice(ui.indexOf('<colgroup>'), ui.indexOf('</colgroup>'));
  assert.equal((columns.match(/<col className=/g) ?? []).length, 19);
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
  assert.match(coverage, /greatest\(i\.purchase_factor::bigint,1\)::numeric/);
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
    const smallest = (shortageSmallest === 0n ? 1n : (shortageSmallest + lot - 1n) / lot) * lot;
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
    assert.ok(x.firstUnits >= 1n);
  }
  assert.deepEqual(expected(17n,12n,12n), {firstUnits:2n,smallest:24n});
  assert.deepEqual(expected(17n,100n,1n), {firstUnits:1n,smallest:100n});
  assert.deepEqual(expected(0n,12n,12n), {firstUnits:1n,smallest:12n});
  assert.deepEqual(expected(0n,2n,10n), {firstUnits:5n,smallest:10n});
  assert.deepEqual(expected(0n,10n,3n), {firstUnits:3n,smallest:30n});
});


test("item-options totals aggregate all filtered items by currency; derived sorts are database-wide", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const schema = read("packages/contracts/src/item-options-presets.ts");
  assert.match(api, /replenishment AS MATERIALIZED/);
  assert.match(api, /FROM filtered f\s+JOIN items i/);
  assert.match(api, /SUM\(order_value\)::text/);
  assert.match(api, /GROUP BY currency_code/);
  assert.match(api, /jsonb_agg\(jsonb_build_object\(/);
  assert.match(api, /requiredPurchaseValueTotals:/);
  assert.match(api, /SELECT \* FROM replenishment f ORDER BY \$\{order\} LIMIT \$\{limit\} OFFSET \$\{offset\}/);
  assert.match(api, /options\.coverageWithReserveMax \?\? "30"/);
  assert.match(api, /values\.push\(options\.coverageWithReserveMax \?\? "30", "true"\)/);
  assert.match(api, /purchasePrice: "f\.purchase_price"/);
  assert.match(api, /saleQuantityMonth: "f\.sale_quantity_month"/);
  assert.match(api, /requiredPurchaseQuantity: "f\.order_quantity_first_unit"/);
  assert.match(api, /requiredPurchaseValue: "f\.order_value"/);
  assert.match(api, /coverageWithRequired: "f\.projected_coverage_days"/);
  for(const key of [
    "saleQuantityMonth", "purchasePrice", "requiredPurchaseQuantity",
    "requiredPurchaseValue", "coverageWithRequired"
  ]) {
    assert.ok(ui.includes(`sortHeader("${key}"`), "sortable header: " + key);
    assert.ok(schema.includes(`"${key}"`), "saved preset sort: " + key);
  }
  assert.match(ui, /إجمالي قيمة المطلوب:/);
  assert.match(ui, /result\.requiredPurchaseValueTotals\.map/);
  assert.match(ui, /formatAmountGroup\(entry\.value\)/);
});


test("item-options stop-order control excludes only future card dates by default", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const preset = read("packages/contracts/src/item-options-presets.ts");
  assert.match(api, /excludeOrderStopped: z\.enum\(\["true", "false"\]\)\.default\("true"\)/);
  assert.match(api, /i\.order_stopped_until IS NULL OR i\.order_stopped_until <= \$2::date/);
  assert.match(api, /options\.excludeOrderStopped/);
  assert.match(api, /clock_timestamp\(\) AT TIME ZONE 'Asia\/Aden'/);
  // Applied to the candidate CTE used by both listing and bulk draft export.
  assert.ok(api.indexOf("i.order_stopped_until IS NULL") < api.indexOf("staged AS ("));
  assert.match(ui, /excludeOrderStopped: params\.get\("excludeOrderStopped"\) !== "false"/);
  assert.match(ui, /checked=\{draft\.excludeOrderStopped\}/);
  assert.match(ui, /إيقاف طلب الأصناف الموقوفة حتى تاريخ مستقبلي/);
  assert.match(ui, /if \(!draft\.excludeOrderStopped\) next\.set\("excludeOrderStopped", "false"\)/);
  assert.match(ui, /if\(!values\.excludeOrderStopped\) next\.set\("excludeOrderStopped","false"\)/);
  assert.match(ui, /if \(params\.get\("excludeOrderStopped"\) === "false"\) request\.set\("excludeOrderStopped", "false"\)/);
  assert.match(preset, /excludeOrderStopped: z\.boolean\(\)\.default\(true\)/);
  assert.match(ui, /monthMin: "1", yearMin: "2", coverageWithReserveMax: "1"/);
  assert.match(ui, /key === "monthMin" \|\| key === "coverageWithReserveMax" \? "1"/, "reserved coverage defaults must use one day");
  // The purchase/value/coverage totals all use filtered, not unfiltered rows.
  assert.match(api, /FROM filtered f/);
});


test("monthly sold quantity in item options is FIRST-unit and rolling year count is filtered", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const schema = read("packages/contracts/src/item-options-presets.ts");
  const coverage = read("apps/api/src/services/item-coverage.ts");
  assert.match(api, /sale_rank\.net_sale_quantity/);
  assert.match(api, /staged_rank\.net_sale_quantity/);
  assert.match(api, /greatest\(i\.factor2::numeric\*i\.factor3::numeric,1\),4\) AS sale_quantity_month/);
  assert.match(api, /saleQuantityMonth: String\(row\.sale_quantity_month\)/);
  assert.match(api, /saleQuantityMonth: "f\.sale_quantity_month"/);
  assert.match(ui, /كمية مباعة في شهر \(الوحدة الأولى\)/);
  assert.doesNotMatch(ui, /كمية مباعة في شهر \(أصغر وحدة\)/);
  assert.match(api, /WHERE d\.document_date>=\(\$2::date-interval '1 year'\+interval '1 day'\)::date\),0\) AS year/);
  assert.match(api, /COALESCE\(s\.year,0\) AS sale_times_year/);
  assert.match(api, /range\(options\.yearMin, "m\.sale_times_year", ">="\)/);
  assert.match(api, /range\(options\.yearMax, "m\.sale_times_year", "<="\)/);
  assert.match(api, /saleTimesYear: String\(row\.sale_times_year\)/);
  assert.match(api, /year: "f\.sale_times_year"/);
  assert.match(ui, /\{ key: "fourMonthsMax".*\n.*\{ key: "yearMin", label: "المبيعات مرات في عام من" \}/);
  assert.match(ui, /\{ key: "yearMax", label: "المبيعات مرات في عام إلى" \}/);
  assert.match(ui, /yearMin: params\.get\("yearMin"\) \?\? "2"/);
  assert.match(ui, /yearMin: "2", coverageWithReserveMax: "1"/);
  assert.match(ui, /key === "yearMin" \? "2"/);
  assert.match(ui, /key === "yearMin" \|\| key === "coverageWithReserveMax"/);
  assert.match(schema, /yearMin: numericRange\.default\(""\)/);
  assert.match(schema, /yearMax: numericRange\.default\(""\)/);
  assert.match(coverage, /coverage_rate\.sales/);
  // Example provided in the screenshot: 9722 smallest strip-parts /
  // 50 smallest parts per first selling unit = 194.44 first units.
  assert.equal(9722 / (50 * 1), 194.44);
  // Days of coverage are unit-neutral when stock and sales are converted together.
  const daysSmallest = 82 * 30 / 9722;
  const daysFirst = (82 / 50) * 30 / (9722 / 50);
  assert.ok(Math.abs(daysSmallest - daysFirst) < 1e-12);
  const oldPreset = itemOptionsPresetFiltersSchema.parse({
    q: "", active: "active", stockMin: "", stockMax: "", monthMin: "1",
    monthMax: "", fourMonthsMin: "", fourMonthsMax: "",
    allTimeMin: "", allTimeMax: "", coverageMin: "", coverageMax: "1",
    excludeZero: false, useReserve: true, sortBy: "allTime", sortDir: "desc",
  });
  assert.equal(oldPreset.yearMin, "");
  assert.equal(oldPreset.yearMax, "");
  assert.equal(itemOptionsPresetFiltersSchema.parse({
    ...oldPreset, yearMin: "2", yearMax: "40", sortBy: "year"
  }).sortBy, "year");
});


test("nonzero minimum order is identical in row proposal and full-filter total", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const coverage = read("apps/api/src/services/item-coverage.ts");
  for (const sql of [api, coverage]) {
    assert.match(sql, /greatest\(1::numeric, ceil\(greatest\(0::numeric,/);
    assert.match(sql, /\/ \(purchase_lot\.minimum_lot_first_unit \* purchase_lot\.first_unit_smallest\)\)\)/);
    assert.match(sql, /greatest\(i\.purchase_factor::bigint,1\)::numeric AS minimum_lot_first_unit/);
  }
  assert.match(api, /SUM\(order_value\)::text/);
  assert.match(coverage, /required_purchase_quantity/);
});


test("any item-options row click updates avatar item-shortcut selection without navigating", () => {
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const recent = read("apps/web/src/recent-entities.ts");
  const menu = read("apps/web/src/EntityMenuSearch.tsx");
  const css = read("apps/web/src/styles.css");
  assert.match(ui, /function rememberItem\(row: Row\) \{\s*if \(user\) rememberRecentEntity\(user\.id, companyId, "item"/);
  assert.match(ui, /<article key=\{row\.itemId\}[\s\S]*?role="listitem" onClick=\{\(\) => rememberItem\(row\)\}>/);
  assert.match(ui, /<tr key=\{row\.itemId\}[\s\S]*?onClick=\{\(\) => rememberItem\(row\)\}>/);
  assert.match(ui, /<input type="checkbox" aria-label=\{\`اختيار الصنف/);
  assert.match(ui, /<ItemReserveQuickEdit/);
  assert.match(ui, /<ItemPurchaseFactorQuickEdit/);
  assert.match(recent, /window\.dispatchEvent\(new CustomEvent\(RECENT_ENTITY_EVENT/);
  assert.match(menu, /window\.addEventListener\(RECENT_ENTITY_EVENT, onChange\)/);
  assert.match(menu, /setRecent\(detail\.value\)/);
  assert.match(menu, /<ItemMenuHistory[^>]*userId=\{user\.id\}/);
  assert.match(css, /\.item-options-desktop-table tbody tr,\s*\.item-options-mobile-entry \{ cursor: pointer; \}/);
});

test("one day is the fresh-page and reset default, without overwriting explicit filter values", () => {
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  assert.match(ui, /coverageWithReserveMax: params\.get\("coverageWithReserveMax"\) \?\? "1"/);
  assert.match(ui, /key === "monthMin" \|\| key === "coverageWithReserveMax" \? "1"/);
  assert.match(ui, /monthMin: "1", yearMin: "2", coverageWithReserveMax: "1"/);
  // Old links or shared presets can intentionally contain 2: they remain explicit choices.
  assert.match(ui, /next\.set\(key, value\)/);
  assert.match(ui, /if \(value \|\| key === "stockMin"/);
});


test("legacy wrong first-unit import gets an isolated, source-scoped planning-only correction", () => {
  const sql = read("apps/api/migrations/20261105_legacy_sales_planning_quantity_overlay.sql");
  const coverage = read("apps/api/src/services/item-coverage.ts");
  const api = read("apps/api/src/routes-item-options-list.ts");
  assert.match(sql,/CREATE TABLE legacy_sales_planning_line_deltas/);
  assert.match(sql,/CREATE TABLE legacy_sales_planning_daily_deltas/);
  assert.match(sql,/NEW\.source_system='dar-aldawa-legacy-2026-10'/);
  assert.match(sql,/m\.source_system='dar-aldawa-legacy-2026-10'/);
  assert.match(sql,/NEW\.unit_price=i\.sale_price2/);
  assert.match(sql,/l\.unit_price=i\.sale_price2/);
  assert.match(sql,/NEW\.unit=1/);
  assert.match(sql,/l\.unit=1/);
  assert.match(sql,/inv\.kind='sale'/);
  assert.match(sql,/origin='posted'/);
  assert.match(sql,/d\.origin='staged'/);
  assert.match(sql,/NEW\.quantity\*\(i\.factor3::numeric-i\.factor2::numeric\*i\.factor3\)/);
  assert.match(sql,/l\.quantity\*\(l\.factor3::numeric-l\.factor2::numeric\*l\.factor3\)/);
  assert.doesNotMatch(sql,/UPDATE (?:invoices|invoice_lines|stock_movements|item_daily_activity) SET/);
  assert.match(coverage,/FROM item_daily_activity/);
  assert.match(coverage,/FROM staged_item_daily_activity_cache/);
  assert.match(coverage,/FROM legacy_sales_planning_daily_deltas/);
  assert.match(api,/COALESCE\(planning_fix\.month_delta,0\)/);
  assert.match(api,/SUM\(quantity_delta\) AS month_delta/);
  // Exact 5 pieces at 100 YER, incorrectly marked 5 packs of 50:
  const soldOld = 5*50;
  const correction = 5*(1-50);
  assert.equal(soldOld+correction,5);
  // Inverse sign on returned packs must also be corrected: -4 packs -> -4 pieces.
  assert.equal(-4*50 + -4*(1-50),-4);
});


test("default-on exclusion removes locally drafted items before counts and amounts", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const preset = read("packages/contracts/src/item-options-presets.ts");
  assert.match(api, /excludeOrderDrafts: z\.enum\(\["true", "false"\]\)\.default\("true"\)/);
  assert.match(api, /excludedItemIds: z\.array\(z\.number\(\)\.int\(\)\.min\(1\)\.max\(2147483647\)\)\.max\(50000\)/);
  assert.match(api, /options\.excludeOrderDrafts && excludedDraftItemIds\.length/);
  assert.match(api, /NOT \(i\.id = ANY\(/);
  assert.ok(api.indexOf("NOT (i.id = ANY(") < api.indexOf("filtered AS ("));
  assert.match(api, /router\.post\("\/companies\/:companyId\/item-options-list\/query"/);
  assert.match(api, /router\.post\("\/companies\/:companyId\/item-options-list\/unselected\/query"/);
  assert.match(ui, /excludeOrderDrafts: params\.get\("excludeOrderDrafts"\) !== "false"/);
  assert.match(ui, /checked=\{draft\.excludeOrderDrafts\}/);
  assert.match(ui, /استثناء الأصناف المرحّلة إلى مسودات الطلبيات/);
  assert.match(ui, /temporaryOrder\.drafts\.flatMap/);
  assert.match(ui, /queryKey: \["item-options-list"[^]*draftExclusionKey\]/);
  assert.match(ui, /excludedItemIds: excludedDraftItemIds/);
  assert.match(ui, /if \(!draft\.excludeOrderDrafts\) next\.set\("excludeOrderDrafts", "false"\)/);
  assert.match(ui, /if\(!values\.excludeOrderDrafts\) next\.set\("excludeOrderDrafts","false"\)/);
  assert.match(preset, /excludeOrderDrafts: z\.boolean\(\)\.default\(true\)/);
  assert.match(ui, /مسودات الطلبيات محفوظة على هذا الجهاز فقط، وتُحذف كل مسودة تلقائيًا بعد 8 ساعات/);
});


test("bulk order draft saves exactly the first-unit required column, and prints it in both columns", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const page = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const core = read("apps/web/src/numbered-order-drafts-core.ts");
  const pdf = read("apps/web/src/item-names-pdf.ts");
  const css = read("apps/web/src/styles.css");
  assert.match(api,/if \(unselectedForDraft\) \{/);
  assert.match(api,/const requested = await requiredPurchaseQuantitiesToPage\(/);
  assert.match(api,/client, companyId, ids, options\.coverageWithReserveMax \?\? "30", true/);
  assert.match(api,/requiredQuantity: requested\.get\(Number\(row\.id\)\)!\.requiredPurchaseQuantity/);
  assert.match(api,/order_draft_quantity_unavailable/);
  assert.match(page,/items: OrderDraftItem\[\]; total: number/);
  assert.match(page,/temporaryOrder\.createDraft\(candidates\)/);
  assert.match(core,/OrderDraftItem = TemporaryChosenItem & \{ requiredQuantity\?: string \}/);
  assert.match(core,/row\.requiredQuantity/);
  assert.match(core,/rows\.push\(\{ id: row\.id, name: row\.name, code: row\.code,/);
  assert.match(page,/className="item-options-order-quantity"/);
  assert.match(page,/item\.requiredQuantity \?\? "—"/);
  assert.match(page,/printMode !== "selected"/);
  assert.match(page,/className="item-options-print-quantity"/);
  assert.match(page,/requiredQuantity: savedRequiredQuantity\(item\)/);
  assert.match(pdf,/quantityWidth/);
  assert.match(pdf,/right - quantityWidth/);
  assert.match(css,/\.item-options-print-row \.item-options-print-quantity/);
  assert.match(css,/column-count: 2/);
});

test("item option filters auto-apply without buttons, including saved preset selection", () => {
  const page = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const css = read("apps/web/src/styles.css");
  assert.match(page, /function appliedFilterParams\(/);
  assert.match(page, /function scheduleAutoFilter\(/);
  assert.match(page, /setTimeout\(\(\) => \{/);
  assert.match(page, /}, 500\)/);
  assert.match(page, /setDraft\(next\); scheduleAutoFilter\(next, search\)/);
  assert.match(page, /scheduleAutoFilter\(draft, event\.target\.value\)/);
  assert.match(page, /void runFilterApplication\(\(\) => setParams\(previous =>/);
  assert.match(page, /const choice = presets\.find\(preset => String\(preset\.id\) === id\)/);
  assert.match(page, /if \(choice\) \{ cancelAutoFilter\(\); applyPreset\(choice\); \}/);
  assert.doesNotMatch(page, /<Button[^>]*>\s*\{applyingFilter \? "جارٍ تطبيق الخيارات…" : "تطبيق الخيارات"\}/);
  assert.doesNotMatch(page, /onClick=\{\(\)=>\{if\(selectedPreset\) void applyPreset\(selectedPreset\);\}\}/);
  assert.match(page, /monthMin: "1", yearMin: "2", coverageWithReserveMax: "1"/);
  assert.match(css, /\.item-options-presets-card \.item-options-preset-field > input,/);
  assert.match(css, /\.item-options-presets-card \.item-options-preset-field > select \{/);
  assert.match(css, /padding-block: 23px 5px/);
});

test("numbered order drafts remain visible; only draft ITEMS can be collapsed", () => {
  const page = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const css = read("apps/web/src/styles.css");
  const draftIndex = page.indexOf("className=\"item-options-drafts-card\"");
  const resultsIndex = page.indexOf("<Card title=\"نتائج قائمة الأصناف\">");
  assert.ok(draftIndex > 0 && resultsIndex > draftIndex,
    "Draft list is a separate card before results, not nested in a hidden results section");
  assert.doesNotMatch(page, /showOrderDraft|setShowOrderDraft/);
  assert.match(page, /مسودات الطلبيات \(\$\{temporaryOrder\.drafts\.length\}\)/);
  assert.match(page, /activeOrderDraftId === orderDraft\.id \? "إخفاء الأصناف" : "عرض الأصناف"/);
  assert.match(page, /\{activeOrderDraftId === orderDraft\.id && <div className="item-options-order-draft-lines">/);
  assert.match(page, /className="item-options-order-draft-meta"/);
  assert.match(page, /className="item-options-order-draft-buttons"/);
  assert.match(css, /\.item-options-order-draft-meta \{/);
  assert.match(css, /\.item-options-order-draft-buttons \{/);
  assert.match(css, /\.item-options-drafts-card \.item-options-order-draft-lines \{/);
  assert.match(css, /max-height: min\(46dvh, 420px\)/);
});

test("coverage columns display gross and net-of-reserve sufficiency independently", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const coverage = read("apps/api/src/services/item-coverage.ts");
  const ui = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const schema = read("packages/contracts/src/item-options-presets.ts");
  // Physical available inventory is showroom + non-return warehouse only.
  assert.match(coverage, /coalesce\(coverage_stock\.stock_showroom,0\)\+/);
  assert.match(coverage, /coalesce\(coverage_stock\.stock_warehouse,0\)/);
  assert.match(coverage, /coalesce\(coverage_stock\.stock_warehouse,0\)-i\.reserve_quantity,0\)/);
  assert.match(coverage, /coverage_rate\.quantity \* coverage_rate\.days \/ coverage_rate\.sales/);
  assert.match(coverage, /coverage_rate\.after_reserve \* coverage_rate\.days \/ coverage_rate\.sales/);
  // Both values are always returned, independently of the ordering switch.
  assert.match(api, /coverage: "f\.coverage_before"/);
  assert.match(api, /coverageWithReserve: "f\.coverage_after_reserve"/);
  assert.match(api, /coverage: "f\.coverage_before"/);
  assert.match(api, /approximateCoverageDays: row\.approximateCoverageDays/);
  assert.match(api, /coverageAfterReserveDays: row\.coverageAfterReserveDays/);
  assert.match(ui, /sortHeader\("coverage", "الكفاية بدون الاحتياط \(يوم\)"\)/);
  assert.match(ui, /sortHeader\("coverageWithReserve", "الكفاية مع الاحتياط \(يوم\)"\)/);
  assert.match(ui, /row\.approximateCoverageDays \?\? "—"/);
  assert.match(ui, /row\.coverageAfterReserveDays \?\? "—"/);
  // Each range filters its own metric; replenishment always protects reserve stock.
  assert.match(api, /range\(options\.coverageMin, "m\.coverage_before", ">="\)/);
  assert.match(api, /range\(options\.coverageMax, "m\.coverage_before", "<="\)/);
  assert.match(api, /range\(options\.coverageWithReserveMin, "m\.coverage_after_reserve", ">="\)/);
  assert.match(api, /range\(options\.coverageWithReserveMax, "m\.coverage_after_reserve", "<="\)/);
  assert.match(api, /options\.coverageWithReserveMax \?\? "30", true/);
  assert.doesNotMatch(ui, /checked=\{draft\.useReserve\}/);
  assert.match(ui, /coverageWithReserveMax: params\.get\("coverageWithReserveMax"\) \?\? "1"/);
  assert.match(ui, /coverageMax: params\.get\("coverageMax"\) \?\? ""/);
  // Explicit modern preset column choices must not be overriden on load.
  assert.match(schema, /coverageColumnsVersion: z\.literal\(2\)\.optional\(\)/);
  assert.match(schema, /"coverage", "coverageWithReserve", "coverageWithRequired"/);
  assert.equal(itemOptionsPresetFiltersSchema.parse({
    q:"", active:"active", stockMin:"", stockMax:"", reserveMin:"", reserveMax:"",
    monthMin:"", monthMax:"", fourMonthsMin:"", fourMonthsMax:"",
    allTimeMin:"", allTimeMax:"", previousYearMin:"", previousYearMax:"",
    coverageMin:"", coverageMax:"", excludeZero:false, useReserve:true,
    sortBy:"coverageWithReserve", sortDir:"asc", coverageColumnsVersion:2,
    visibleColumns:["coverage","coverageWithReserve"],
  }).sortBy, "coverageWithReserve");
});

test("purchase factor means multiples of FIRST units in both SQL calculations", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  const coverage = read("apps/api/src/services/item-coverage.ts");
  for (const sql of [api, coverage]) {
    assert.match(sql, /greatest\(i\.purchase_factor::bigint,1\)::numeric\s+AS minimum_lot_first_unit/);
    assert.match(sql, /\/ \(purchase_lot\.minimum_lot_first_unit \* purchase_lot\.first_unit_smallest\)\)\)/);
    assert.match(sql, /\* purchase_lot\.minimum_lot_first_unit \* purchase_lot\.first_unit_smallest/);
    assert.match(sql, /requested\.quantity_smallest \/ purchase_lot\.first_unit_smallest/);
    assert.doesNotMatch(sql, /minimum_lot_smallest|lcm\(greatest\(i\.purchase_factor/);
  }
  // A strip has 10 tablets: factor 10 means 10 strips, not just 10 tablets.
  const requestedFirst = (neededSmallest: number, firstUnitSize: number, factor: number) =>
    Math.max(1, Math.ceil(Math.max(0, neededSmallest) / (firstUnitSize * factor))) * factor;
  for (const [need, unitSize, factor, expected] of [
    [0, 10, 10, 10], [5, 10, 10, 10], [100, 10, 10, 10],
    [101, 10, 10, 20], [0, 2, 5, 5], [31, 2, 5, 20],
    [0, 1, 1, 1], [31, 10, 3, 6],
  ]) assert.equal(requestedFirst(need, unitSize, factor), expected);
  assert.match(coverage,
    /i\.purchase_factor \* greatest\(i\.factor2::numeric \* i\.factor3::numeric,1\)/);
});
