import assert from "node:assert/strict";
import test from "node:test";
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
