import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
const css = readFileSync("apps/web/src/styles.css", "utf8");
const phoneRule = css.slice(css.indexOf("/* Phone sales entry: show each editable invoice line as two complete bands."));

test("mobile invoice layout applies to sales only, including expiry returns", () => {
  assert.match(page, /commerce-matrix-purchase" : `commerce-matrix-sale/);
  assert.match(page, /commerce-matrix-sale-has-expiry/);
  assert.match(css, /@media screen and \(max-width: 680px\)/);
  assert.match(phoneRule, /\.commerce-matrix-sale tbody > tr\s*\{[\s\S]*?display: grid;/);
  assert.match(phoneRule, /grid-template-rows: auto auto;/);
  assert.match(phoneRule, /\.commerce-matrix-sale-has-expiry \.commerce-line-expiry/);
  assert.doesNotMatch(phoneRule, /\.commerce-matrix-purchase tbody > tr/);
});

test("item name stays readable and all existing invoice inputs remain mounted", () => {
  assert.match(page, /className="commerce-mobile-sale-item-name" dir="auto"/);
  assert.match(phoneRule, /\.commerce-mobile-sale-item-name\s*\{[\s\S]*?white-space: normal;[\s\S]*?overflow-wrap: anywhere;/);
  for (const field of ["unit", "quantity", "price", "expiry"]) {
    assert.match(page, new RegExp('className="commerce-line-' + field + '"'));
  }
  for (const field of ["total", "available", "shelf", "action-cell"]) {
    assert.match(page, new RegExp('className="commerce-line-' + field + '"'));
  }
  assert.match(phoneRule, /\.commerce-matrix-sale \.commerce-line-unit \{ grid-column: 1 \/ span 3; grid-row: 2; \}/);
  assert.match(phoneRule, /\.commerce-matrix-sale \.commerce-line-action-cell \{ grid-column: 11 \/ span 2; grid-row: 1; \}/);
});

test("mobile sales no longer forces a 700px-wide scrolling table", () => {
  assert.match(phoneRule, /\.commerce-matrix-sale\s*\{[\s\S]*?min-width: 0;/);
  assert.match(phoneRule, /\.commerce-matrix-card \.commerce-lines-scroll:has\(> \.commerce-matrix-sale\)/);
  assert.match(phoneRule, /overflow-x: hidden;/);
});
