import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  canSearchInvoiceItem,
  MIN_INVOICE_ITEM_SEARCH_LENGTH,
} from "../packages/contracts/src/invoice-item-search.ts";

test("invoice item suggestions begin only on the third visible character", () => {
  assert.equal(MIN_INVOICE_ITEM_SEARCH_LENGTH, 3);
  for (const input of ["", " ", "س", "سك", "  سك ", "12"]) {
    assert.equal(canSearchInvoiceItem(input), false, input);
  }
  for (const input of ["سكر", "  سكر  ", "123", "123456789", "AB3"]) {
    assert.equal(canSearchInvoiceItem(input), true, input);
  }
});

test("Unicode and whitespace do not trigger premature requests", () => {
  assert.equal(canSearchInvoiceItem("😀😀"), false);
  assert.equal(canSearchInvoiceItem("😀😀😀"), true);
  assert.equal(canSearchInvoiceItem("  م ل "), false);
  assert.equal(canSearchInvoiceItem("  م ل ك "), true);
  assert.equal(canSearchInvoiceItem("سُكَّ"), false);
});

test("invoice typeahead stays fast and reads stored monthly rankings", () => {
  const form = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  const route = readFileSync("apps/api/src/routes-commerce-options.ts", "utf8");
  const rank = readFileSync("apps/api/src/services/item-sale-ranking.ts", "utf8");
  const search = form.slice(form.indexOf("function ItemSearch({"),form.indexOf("function OriginalInvoicePicker({"));
  assert.match(search, /window\.setTimeout\(\(\) => \{[\s\S]*?\}, 100\)/);
  assert.match(search, /searchCurrent && result\.isSuccess/);
  assert.doesNotMatch(search, /searchCurrent && !result\.isFetching && result\.isSuccess/);
  assert.match(search, /canSearchInvoiceItem\(search\)/);
  assert.match(search, /sort: "saleTimes:desc,code:asc", fast: "1"/);
  assert.match(route, /fastItemLookup/);
  assert.match(route, /itemLookupSearchPlan/);
  assert.match(rank, /item_sale_rankings sale_rank/);
  assert.match(rank, /staged_item_sale_rankings staged_rank/);
  assert.doesNotMatch(rank,/FROM invoice_lines/);
});
