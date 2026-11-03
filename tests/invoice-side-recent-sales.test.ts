import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const side = readFileSync("apps/web/src/InvoiceSideOverview.tsx","utf8");
const recent = readFileSync("apps/web/src/InvoiceSideRecentSales.tsx","utf8");
const workspace = readFileSync("apps/web/src/pages/CommercePages.tsx","utf8");
const backend = readFileSync("apps/api/src/routes-commerce.ts","utf8");

test("invoice side panel exposes five newest company sale invoices on selection only", () => {
  assert.match(side,/value: "recentSales", label: "آخر فواتير المبيعات"/);
  assert.match(side,/view === "recentSales" \? \(/);
  assert.match(side,/<InvoiceSideRecentSales context=\{context\}/);
  assert.match(workspace,/<InvoiceSideOverview context=\{context\}/);
  assert.match(recent,/kind=sale&page=1&pageSize=5&sort=id:desc/);
  assert.doesNotMatch(recent,/dateFrom=|dateTo=/);
  assert.match(recent,/enabled: !!user && !offline/);
  assert.match(backend,/await readCommerce\(pool, req/);
});
test("the exact four columns are present and customer is editable even when blank", () => {
  const header=recent.match(/<thead><tr>[\s\S]*?<\/tr><\/thead>/)?.[0];
  assert.ok(header);
  assert.deepEqual([...header.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(x=>x[1]),
    ["طباعة","الصافي","الحساب","اسم العميل"]);
  assert.match(recent,/invoice\.saleCustomerName \|\| "—"/);
  assert.match(recent,/onClick=\{\(\) => startEdit\(invoice\)\}/);
  assert.match(recent,/canEditCustomer = context\.general \|\| context\.permissions\.includes\("commerce\.manage"\)/);
});
test("uses the existing safe snapshot customer PATCH and same-page print job", () => {
  assert.match(recent,/invoice\.id \+ "\/sale-customer"/);
  assert.match(recent,/expectedSaleCustomerId: invoice\.saleCustomerId/);
  assert.match(recent,/expectedSaleCustomerNumber: invoice\.saleCustomerNumber/);
  assert.match(recent,/expectedSaleCustomerName: invoice\.saleCustomerName/);
  assert.match(recent,/normalizeDigits\(event\.target\.value\)/);
  assert.match(recent,/queryClient\.setQueryData<Page<Invoice>>/);
  assert.match(recent,/invalidateQueries/);
  assert.match(recent,/<InvoiceListPrintJob key=\{printJob\.sequence\}/);
  assert.doesNotMatch(recent,/window\.open\(|target="_blank"/);
  assert.match(backend,/UPDATE invoices SET sale_customer_id=\$1,sale_customer_number=\$2,sale_customer_name=\$3/);
});
