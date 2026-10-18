import assert from "node:assert/strict";
import test from "node:test";
import { printedExpiry, printedInvoiceColumns } from "../apps/web/src/InvoicePrintSheet.tsx";

test("printed sales invoices contain only the five requested matrix columns", () => {
  assert.deepEqual(printedInvoiceColumns("sale"), [
    "اسم الصنف", "الكمية", "الوحدة", "السعر", "القيمة",
  ]);
  assert(!printedInvoiceColumns("sale").includes("البونص"));
  assert(!printedInvoiceColumns("sale").includes("تاريخ الانتهاء"));
});

test("printed purchases reserve bonus before price and retain month/year expiry", () => {
  assert.deepEqual(printedInvoiceColumns("purchase"), [
    "اسم الصنف", "الكمية", "الوحدة", "البونص", "السعر", "تاريخ الانتهاء", "القيمة",
  ]);
  assert.equal(printedExpiry("2027-01-01"), "2027-01");
  assert.equal(printedExpiry("2027-12-31"), "2027-12");
  assert.equal(printedExpiry(null), "—");
});
