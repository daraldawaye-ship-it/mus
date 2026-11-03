import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const print = readFileSync("apps/web/src/InvoicePrintSheet.tsx", "utf8");
const styles = readFileSync("apps/web/src/styles.css", "utf8");

test("sales receipt replaces account number with optional customer name", () => {
  assert.match(print, /\{purchase \? \(\s*<div><dt>رقم الحساب<\/dt>/);
  assert.match(print, /invoice\.saleCustomerName\?\.trim\(\) \? \(/);
  assert.match(print, /<div><dt>اسم العميل<\/dt><dd>\{invoice\.saleCustomerName\}<\/dd><\/div>/);
});

test("only purchase receipts retain branch, location, and currency details", () => {
  assert.match(print, /\{purchase && \(\s*<>\s*<div><dt>الفرع<\/dt>/);
  assert.match(print, /<div><dt>الموقع<\/dt>/);
  assert.match(print, /<div><dt>العملة<\/dt>/);
});

test("sales totals share one horizontal row without changing purchase structure", () => {
  assert.match(styles, /\.invoice-print-sheet--sale \.invoice-print-summary\s*\{\s*display: grid;/);
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(print, /purchase \? `الصافي \(\$\{invoice\.currencyCode\}\)` : "الصافي"/);
});

test("sales acknowledgement is one line without receiver section", () => {
  assert.match(print, /\) : \(\s*<div className="invoice-print-acknowledgements invoice-print-acknowledgements--sale">/);
  assert.match(styles, /\.invoice-print-acknowledgements--sale\s*\{\s*display: flex;\s*flex-direction: row;/);
  assert.match(print, /\{purchase \? \(\s*<div className="invoice-print-acknowledgements">/);
});
