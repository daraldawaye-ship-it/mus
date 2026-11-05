import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../apps/web/src/pages/ItemOptionsListPage.tsx", import.meta.url),
  "utf8",
);
function between(first: string, last: string, from = 0) {
  const index = source.indexOf(first, from);
  assert.ok(index >= 0, `Missing layout marker ${first}`);
  const begin = index + first.length;
  const end = source.indexOf(last, begin);
  assert.ok(end >= 0, `Missing layout marker ${last}`);
  return source.slice(begin, end);
}
const laptop = [
  "choice", "stock", "saleQuantityMonth", "name", "reserve",
  "purchaseFactor", "month", "fourMonths", "allTime", "previousYear",
  "requiredPurchaseQuantity", "purchasePrice", "requiredPurchaseValue",
  "purchaseNotes", "coverage", "coverageWithRequired",
  "reserveCoverage", "purchaseFactorCoverage",
];
const phone = [
  "stock", "saleQuantityMonth", "requiredPurchaseQuantity",
  "purchasePrice", "requiredPurchaseValue", "purchaseNotes", "reserve",
  "purchaseFactor", "month", "fourMonths", "allTime", "previousYear",
  "coverage", "coverageWithRequired", "reserveCoverage",
  "purchaseFactorCoverage",
];

test("desktop column tracks, headings and cells use the same order", () => {
  const tracks = Array.from(between("<colgroup>", "</colgroup>").matchAll(
    /visibleColumns\.includes\("([^"]+)"\)/g,
  ), match => match[1]);
  const headings = Array.from(between("<thead><tr>", "</tr></thead>").matchAll(
    /sortHeader\("([^"]+)"|hiddenColumnStyle\("([^"]+)"\)/g,
  ), match => match[1] ?? match[2]);
  const row = between("onClick={() => rememberItem(row)}>", "</tr>)}",
    source.indexOf("<tbody>"));
  const cells = Array.from(row.matchAll(
    /<td\b[^>]*?hiddenColumnStyle\("([^"]+)"\)/g,
  ), match => match[1]);
  assert.deepEqual(tracks, laptop);
  assert.deepEqual(headings, laptop);
  assert.deepEqual(cells, laptop);
});

test("phone prioritizes stock, sold units, requested quantity, and notes after value", () => {
  const stats = between(
    '<div className="item-options-mobile-stats" aria-label="المتوفر ومرات البيع والكفاية">',
    "</article>",
  );
  const columns = Array.from(stats.matchAll(
    /<div style=\{hiddenColumnStyle\("([^"]+)"\)\} className="item-options-mobile-stat/g,
  ), match => match[1]);
  assert.deepEqual(columns, phone);
});
