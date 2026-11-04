import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const commerce = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
const invoiceList = commerce.slice(
  commerce.indexOf("function InvoiceList("),
  commerce.indexOf("  async function saveCustomerChange", commerce.indexOf("function InvoiceList(")),
);
const invoiceDateFilters = commerce.slice(
  commerce.indexOf("function InvoiceList("),
  commerce.indexOf("  const columns = useMemo<ColumnDef<Invoice", commerce.indexOf("function InvoiceList(")),
);
const invoiceFilterControls = commerce.slice(
  commerce.indexOf("        <div className={`table-filters invoice-kind-"),
  commerce.indexOf("        {list.error &&"),
);

test("sales and purchase invoice lists use today for both date bounds unless history or dates are selected", () => {
  assert.match(invoiceList, /const allDates = params\.get\("allDates"\) === "1"/);
  assert.match(invoiceList, /const defaultToday = !allDates &&\s*!params\.has\("dateFrom"\) && !params\.has\("dateTo"\)/);
  assert.match(invoiceList, /const dateFrom = params\.get\("dateFrom"\) \?\? \(defaultToday \? today\(\) : ""\)/);
  assert.match(invoiceList, /const dateTo = params\.get\("dateTo"\) \?\? \(defaultToday \? today\(\) : ""\)/);
  assert.doesNotMatch(invoiceList, /kind === "sale".*defaultToday/);
});

test("both invoice kinds sort by newest id first by default", () => {
  assert.match(invoiceList, /usePagedQuery<Invoice>\([\s\S]*?"id:desc",\s*\)/);
  assert.doesNotMatch(invoiceList, /"id:asc"/);
});

test("purchase invoice dates are editable and can switch between today and all history", () => {
  assert.match(invoiceDateFilters, /function setInvoiceDate\(/);
  assert.match(invoiceDateFilters, /function setInvoiceDateMode\(/);
  assert.match(invoiceFilterControls, /setInvoiceDate\("dateFrom", event\.target\.value\)/);
  assert.match(invoiceFilterControls, /setInvoiceDate\("dateTo", event\.target\.value\)/);
  assert.match(invoiceFilterControls, /setInvoiceDateMode\("today"\)/);
  assert.match(invoiceFilterControls, /setInvoiceDateMode\("all"\)/);
  assert.doesNotMatch(invoiceFilterControls, /kind === "sale" && \(\s*<div className="form-actions"/);
});
