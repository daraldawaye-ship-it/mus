import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { invoiceSaleCustomerPatchSchema } from "../packages/contracts/src/commerce.ts";

function payload(fields: {saleCustomerNumber?:string;saleCustomerName?:string} = {}) {
  return {
    saleCustomerNumber: fields.saleCustomerNumber ?? "",
    saleCustomerName: fields.saleCustomerName ?? "",
    expectedSaleCustomerId: null,
    expectedSaleCustomerNumber: null,
    expectedSaleCustomerName: null,
  };
}

test("posted sales invoice may receive name without number", () => {
  const parsed = invoiceSaleCustomerPatchSchema.parse(payload({
    saleCustomerName: "  سعيد عبدالله  ",
  }));
  assert.equal(parsed.saleCustomerName, "سعيد عبدالله");
  assert.equal(parsed.saleCustomerNumber, "");
});

test("customer number alone preserves leading zeroes; both populated are accepted", () => {
  const parsed = invoiceSaleCustomerPatchSchema.parse(payload({
    saleCustomerNumber: "00777123456",
  }));
  assert.equal(parsed.saleCustomerNumber, "00777123456");
  assert.equal(parsed.saleCustomerName, "");
  assert.equal(invoiceSaleCustomerPatchSchema.safeParse(payload({
    saleCustomerNumber:"0055",saleCustomerName:"اسم",
  })).success, true);
});

test("both fields can be cleared; invalid number and overly long fields are rejected", () => {
  assert.equal(invoiceSaleCustomerPatchSchema.safeParse(payload()).success, true);
  assert.equal(invoiceSaleCustomerPatchSchema.safeParse(payload({
    saleCustomerNumber: "أ123",
  })).success, false);
  assert.equal(invoiceSaleCustomerPatchSchema.safeParse(payload({
    saleCustomerNumber: "1".repeat(31),
  })).success, false);
  assert.equal(invoiceSaleCustomerPatchSchema.safeParse(payload({
    saleCustomerName: "س".repeat(241),
  })).success, false);
});

test("stale invoice edits require expected customer snapshots", () => {
  const data = invoiceSaleCustomerPatchSchema.safeParse({
    saleCustomerNumber: "1", saleCustomerName: "محمد",
  });
  assert.equal(data.success, false);
});

test("API route changes only sale_customer fields, checks company and snapshot, and audits", () => {
  const backend = readFileSync("apps/api/src/routes-commerce.ts", "utf8");
  const section = backend.match(/router\.patch\(\`\$\{base\}\/invoices\/:id\/sale-customer\`[\s\S]*?(?=router\.get\(\`\$\{base\}\/memo-feature-impact\`)/)?.[0];
  assert.ok(section, "customer correction route is mounted");
  assert.match(section, /mutateMaster\(pool, req, "commerce\.manage"/);
  assert.match(section, /WHERE company_id=\$1 AND id=\$2 FOR UPDATE/);
  assert.match(section, /original\.kind !== "sale"/);
  assert.match(section, /original\.sale_customer_number !== input\.expectedSaleCustomerNumber/);
  assert.match(section, /UPDATE invoices SET sale_customer_id=\$1,sale_customer_number=\$2,sale_customer_name=\$3/);
  assert.match(section, /invoice\.customer\.update/);
  assert.doesNotMatch(section, /UPDATE (?:accounts|stock|invoice_lines|financial_documents)|createInvoice\(/);
});

test("list has editable click targets for empty and filled cells and a two-field modal", () => {
  const frontend = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  assert.match(frontend, /className="invoice-list-customer-trigger"/);
  assert.match(frontend, /filter\(Boolean\)\.join\(" — "\) \|\| "—"/);
  assert.match(frontend, /setEditingCustomer\(invoice\)/);
  assert.match(frontend, /<Dialog open=\{editingCustomer !== null\}/);
  assert.match(frontend, /saleCustomerNumber: editingCustomerNumber\.trim\(\)/);
  assert.match(frontend, /saleCustomerName: editingCustomerName\.trim\(\)/);
  assert.match(frontend, /expectedSaleCustomerId: current\.saleCustomerId/);
});

test("invoice list print column directly starts existing header-ready receipt print", () => {
  const frontend = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  const columns = frontend.match(/id: "print",[\s\S]*?id: "open"/)?.[0];
  assert.ok(columns, "print column must appear next to view column");
  assert.match(columns, /header: "طباعة"/);
  assert.ok(columns.includes('invoicePath(companyId, row.original.id)}?print=1'));
  assert.match(columns, /target="_blank"/);
  assert.match(frontend, /searchParams\.get\("print"\) === "1"/);
  assert.match(frontend, /!printReady \|\| printRequestedFor\.current === invoiceId/);
  assert.match(frontend, /window\.print\(\)/);
});
