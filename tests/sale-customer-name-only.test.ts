import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { invoiceSchema, normalizeSaleCustomer } from "../packages/contracts/src/commerce.ts";

const sale = {
  idempotencyKey: "c4c4b66b-7a10-457c-96cc-f080a70cb860",
  kind: "sale" as const,
  documentDate: "2026-11-03",
  currencyId: 1,
  branchId: 1,
  locationId: 1,
  counterpartyAccountId: 1,
  saleCustomerNumber: "",
  saleCustomerName: "  عبدالله المريض  ",
  lines: [{ itemId: 1, unit: 1 as const, quantity: "1", unitPrice: "100" }],
};

test("sale customer name survives without a customer number", () => {
  const parsed = invoiceSchema.parse(sale);
  assert.equal(parsed.saleCustomerNumber, "");
  assert.equal(parsed.saleCustomerName, "عبدالله المريض");
  assert.deepEqual(normalizeSaleCustomer(parsed), parsed);
});

test("numbered customer behavior is unchanged; purchase cannot carry sale customer", () => {
  const numbered = invoiceSchema.parse({ ...sale, saleCustomerNumber: "1234" });
  assert.equal(normalizeSaleCustomer(numbered).saleCustomerName, "عبدالله المريض");
  assert.equal(invoiceSchema.safeParse({
    ...sale, kind: "purchase", saleCustomerName: "عبدالله المريض",
  }).success, false);
});

test("the editor and server keep unnumbered names in the invoice snapshot", () => {
  const editor = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  const service = readFileSync("apps/api/src/services/commerce.ts", "utf8");
  assert.match(editor, /saleCustomerName: kind === "sale" \? saleCustomerName\.trim\(\) : ""/);
  assert.match(service, /saleCustomer\?\.name \?\? \(input\.kind==="sale" \? input\.saleCustomerName \|\| null : null\)/);
  assert.match(service, /if \(input\.kind === "sale" && input\.saleCustomerNumber && !importContext\)/);
});

test("printed and detail views display name-only customers independently of ledger account", () => {
  const print = readFileSync("apps/web/src/InvoicePrintSheet.tsx", "utf8");
  const editor = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  assert.match(print, /!purchase && invoice\.saleCustomerName\?\.trim\(\)/);
  assert.match(print, /<dt>اسم العميل<\/dt><dd>\{invoice\.saleCustomerName\}<\/dd>/);
  assert.match(editor, /\(invoice\.saleCustomerNumber \|\| invoice\.saleCustomerName\)/);
});
