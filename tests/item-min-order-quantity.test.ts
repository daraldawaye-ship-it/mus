import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { itemMinOrderQuantitySchema } from "../packages/contracts/src/items.ts";

const read = (path: string) => readFileSync(path, "utf8");

test("minimum order quantity defaults to one and rejects zero, negatives and fractions", () => {
  assert.equal(itemMinOrderQuantitySchema.parse("1"), "1");
  assert.equal(itemMinOrderQuantitySchema.parse("٣"), "3");
  assert.equal(itemMinOrderQuantitySchema.parse("28"), "28");
  for (const value of ["0", "-1", "0.5", "2.5", "", "2147483648"])
    assert.throws(() => itemMinOrderQuantitySchema.parse(value), value);
  const sql = read("apps/api/migrations/20261114_min_order_quantity.sql");
  assert.match(sql, /min_order_quantity integer NOT NULL DEFAULT 1/);
  assert.match(sql, /CHECK \(min_order_quantity >= 1\)/);
});

test("all automatic purchase planners round up to both the minimum and the purchase factor", () => {
  const list = read("apps/api/src/routes-item-options-list.ts");
  const projection = read("apps/api/src/services/item-coverage.ts");
  for (const source of [list, projection]) {
    assert.match(source, /ceil\(i\.min_order_quantity::numeric \/ purchase_lot\.minimum_lot_first_unit\)/);
    assert.match(source, /purchase_lot\.minimum_lot_first_unit \* purchase_lot\.first_unit_smallest/);
    assert.match(source, /greatest\(0::numeric/);
  }
  const suggest = (shortage: bigint, firstUnit: bigint, factor: bigint, min: bigint) => {
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    return [1n, ceilDiv(min, factor), ceilDiv(shortage, factor * firstUnit)]
      .reduce((a, b) => a > b ? a : b) * factor;
  };
  assert.equal(suggest(0n, 12n, 1n, 1n), 1n);
  assert.equal(suggest(0n, 12n, 10n, 1n), 10n);
  assert.equal(suggest(0n, 12n, 10n, 23n), 30n);
  assert.equal(suggest(1200n, 12n, 10n, 23n), 100n);
  assert.equal(suggest(24n, 12n, 10n, 23n), 30n);
});

test("item card, list draft options and quick edit all refer to the same persisted field", () => {
  const card = read("apps/web/src/pages/ItemsPages.tsx");
  const draft = read("apps/web/src/pages/ItemOrderDraftsPage.tsx");
  const api = read("apps/api/src/routes-item-options-list.ts");
  const quick = read("apps/web/src/ItemMinOrderQuantityQuickEdit.tsx");
  assert.match(card, /label="أقل كمية طلب"/);
  assert.match(card, /edit\("minOrderQuantity", event\.target\.value\)/);
  assert.match(draft, /<strong>أقل كمية طلب<\/strong>/);
  assert.match(draft, /minOrderQuantity=\{info\.minOrderQuantity\}/);
  assert.match(api, /i\.min_order_quantity::text AS "minOrderQuantity"/);
  assert.match(api, /router\.patch\("\/companies\/:companyId\/items\/:itemId\/min-order-quantity"/);
  assert.match(quick, /minOrderQuantity: next/);
  // Manual device-local draft quantities remain checked only against purchase
  // unit multiples. They are deliberately NOT compared with minOrderQuantity.
  const manual = draft.split("function DraftQuantityInput(")[1]?.split("function ")[0] ?? "";
  assert.match(manual, /BigInt\(normalized\) % lot/);
  assert.doesNotMatch(manual, /minOrderQuantity/);
});

test("minimum-order quick edit is audited and protects concurrent updates", () => {
  const source = read("apps/api/src/routes-item-options-list.ts");
  const body = source.split('router.patch("/companies/:companyId/items/:itemId/min-order-quantity"')[1]
    ?.split('// Edits only the explicitly configured threshold')[0] ?? "";
  assert.match(body, /assertDirectoryAccess\(listPage, "edit"\)/);
  assert.match(body, /revision=revision\+1/);
  assert.match(body, /audit\(/);
  assert.doesNotMatch(body, /stock_balances|stock_movements|invoice_lines/);
});
