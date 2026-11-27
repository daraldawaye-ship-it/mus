import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyContext } from "../packages/contracts/src/index.ts";
import { SessionProvider } from "../apps/web/src/api.tsx";
import { InvoicePrintSheet, type PrintableInvoice } from "../apps/web/src/InvoicePrintSheet.tsx";
import { PledgeStatementPrint } from "../apps/web/src/PledgeStatementPrint.tsx";
import { salePrintCustomerName } from "../apps/web/src/customer-print.ts";
import type { PledgeStatementData } from "../apps/web/src/pledge-statement-print.ts";

const context = { company: { id: 1, name: "شركة تجريبية" } } as CompanyContext;
const privateName = "الرهونات - زيد أحمد_ت/770000000_الرهن/ساعة خاصة_المدة/2_بواسطة/موظف_(معدل)";
const invoice: PrintableInvoice = {
  kind:"sale", returning:false, number:"42", documentDate:"2026-11-27",
  counterpartyAccountName:privateName, counterpartyAccountCode:"59012",
  saleCustomerName:null, saleCustomerNumber:"123", supplierAccountName:null, supplierReceiptNumber:"",
  branchName:"أمانة", locationName:"المخزن", doctorName:null, currencyCode:"YER",
  description:"ملاحظة مسجلة", gross:"500", discount:"5", total:"495",
  createdByName:"المحاسب", createdAt:"2026-11-27T14:00:00Z", lines:[],
};
function render(element: ReturnType<typeof h>) {
  return renderToStaticMarkup(h(QueryClientProvider,{client:new QueryClient()},
    h(SessionProvider, {children: element})));
}
test("sales print uses just the customer name, including on legacy pledge sales", () => {
  for (const pendingSync of [false,true]) {
    const sale = render(h(InvoicePrintSheet,{context,invoice,returning:false,pendingSync}));
    assert.match(sale,/اسم العميل<\/dt><dd>زيد أحمد/);
    assert.match(sale,/495/);
    assert.match(sale,/ملاحظة مسجلة/);
    assert.doesNotMatch(sale,/العميل \/ الحساب|الرهونات|770000000|59012|ساعة خاصة/);
    const named = render(h(InvoicePrintSheet,{context,invoice:{...invoice,saleCustomerName:"عميل محدد"},returning:false,pendingSync}));
    assert.match(named,/اسم العميل<\/dt><dd>عميل محدد/);
    assert.doesNotMatch(named,/زيد أحمد|123|ساعة خاصة/);
  }
  assert.equal(salePrintCustomerName(null,"صندوق مبيعات داخلي"),"");
  assert.equal(salePrintCustomerName(null,"الرهونات - حساب لا يتبع الصيغة"),"");
});
test("pledge statement prints the name and monetary information without private words or collateral", () => {
  const statement = {
    account:{id:1,code:"59012",name:privateName},
    total:1, totals:{openingBalance:"0",debit:"35",credit:"0",closingBalance:"35",baseCurrencyCode:"YER"},
    items:[{id:1, documentId:1, documentDate:"2026-11-27", kind:"payment",
      description:"صرف مبلغ لرهن: زيد أحمد، ساعة خاصة", baseDebit:"35",baseCredit:"0",runningBalance:"35"}],
  } as PledgeStatementData;
  const sheet = render(h(PledgeStatementPrint,{context,customerName:"زيد أحمد",statement,onLetterheadReady:()=>{}}));
  assert.match(sheet,/<h2>كشف حساب<\/h2>/);
  assert.match(sheet,/<strong>الحساب:<\/strong> زيد أحمد/);
  assert.match(sheet,/2026-11-27/);
  assert.match(sheet,/35/);
  assert.doesNotMatch(sheet,/رهن|ساعة خاصة|770000000|59012/);
});
test("purchase keeps supplier and account information", () => {
  const sheet = render(h(InvoicePrintSheet,{context,invoice:{
    ...invoice,kind:"purchase", counterpartyAccountName:"المورد الأول",
  },returning:false}));
  assert.match(sheet,/المورد \/ الحساب<\/dt><dd>المورد الأول/);
  assert.match(sheet,/59012/);
  assert.doesNotMatch(sheet,/اسم العميل/);
});
