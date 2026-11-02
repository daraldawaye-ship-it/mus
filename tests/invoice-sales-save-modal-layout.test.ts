import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("sales save dialog shows in-control labels for customer and doctor fields", () => {
  const source = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  const dialogStart = source.indexOf("<Dialog open={doctorPromptOpen}");
  const dialogEnd = source.indexOf("{adjustingItem!==null", dialogStart);
  assert.ok(dialogStart > 0 && dialogEnd > dialogStart);
  const modal = source.slice(dialogStart, dialogEnd);
  assert.match(modal, /className="form-stack invoice-customer-doctor-form"/);
  for (const field of [
    "invoice-sale-customer-search",
    "invoice-sale-customer-number",
    "invoice-sale-customer-name",
    "invoice-doctor-name",
  ]) {
    assert.match(modal, new RegExp(`<label htmlFor=\\{fixedInputId\\("${field}"\\)\\}>`));
    assert.match(modal, new RegExp(`<input id=\\{fixedInputId\\("${field}"\\)\\}`));
  }
  assert.match(modal, /className="invoice-customer-identity-row"/);
  assert.match(modal, /data-label-raised="true"/);
  assert.doesNotMatch(modal, /السهمان ↑ ↓ للتنقل/);
  assert.doesNotMatch(modal, /عند حفظ الفاتورة يُنشأ كرت دون فئة ويُرسل تنبيه للمتابعة/);
  // Removal of the hint text must not remove search, suggestions, or keyboard navigation.
  assert.match(modal, /event\.key==="ArrowDown" \|\| event\.key==="ArrowUp"/);
  assert.match(modal, /if\(event\.key==="Enter"\)/);
  assert.match(modal, /setSaleCustomerNumber\(normalizeDigits/);
  assert.match(modal, /setSaleCustomerName\(event\.target\.value\)/);
  assert.match(modal, /customerSearch\.data\?\.items\.map/);
  assert.match(modal, /doctorResults\.map/);
});

test("customer identity fields share a row on desktop and stack on small screens", () => {
  const source = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  const css = readFileSync("apps/web/src/styles.css", "utf8");
  const start = source.indexOf('<div className="invoice-customer-identity-row">');
  const end = source.indexOf('{doctorError&&<Notice', start);
  assert.ok(start > 0 && end > start);
  const pair = source.slice(start,end);
  assert.match(pair,/invoice-sale-customer-number/);
  assert.match(pair,/invoice-sale-customer-name/);
  assert.match(css,/\.invoice-customer-identity-row\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css,/@media\s*\(max-width:\s*680px\)\s*\{\s*\.invoice-customer-identity-row\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /:is\([^\n]*\.invoice-customer-doctor-form\)[\s\S]*?\.field\.floating-ready[^\n]*> label/);
});
