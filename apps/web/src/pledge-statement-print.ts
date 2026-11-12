import type { AccountLedgerLine, AccountLedgerTotals } from "../../../packages/contracts/src/index";
import { documentKindLabels } from "../../../packages/contracts/src/index";
import { api } from "./api";
import { formatMoney } from "./format-money";

type LedgerPage = {
  items: AccountLedgerLine[];
  total: number;
  account: { id: number; code: string; name: string };
  totals: AccountLedgerTotals;
};
type PrintablePledge = { accountId: number; name: string; customerName: string; phone: string; collateral: string };
const safe = (value: unknown): string => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function fetchFullPledgeStatement(companyId: number, accountId: number) {
  const rows: AccountLedgerLine[] = [];
  let first: LedgerPage | undefined;
  for (let page = 1; page <= 1000; page++) {
    const result = await api<LedgerPage>(
      `/companies/${companyId}/pledges/${accountId}/ledger?` +
      new URLSearchParams({
        page: String(page),
        pageSize: "100",
        sort: "documentDate:asc,documentId:asc,lineNumber:asc",
      }),
    );
    if (!first) first = result;
    // Server authorization is pledge-scoped and independent of general finance pages.
    if (result.account.id !== accountId) throw new Error("كشف الحساب لا يخص الرهن المحدد.");
    rows.push(...result.items);
    if (rows.length >= result.total) return { ...first, items: rows };
    if (!result.items.length) throw new Error("تعذر استكمال سطور كشف الرهن.");
  }
  throw new Error("كشف الرهن كبير جدًا للطباعة دفعة واحدة.");
}

export async function printPledgeStatement(
  companyId: number,
  pledge: PrintablePledge,
  win: Window,
): Promise<void> {
  const ledger = await fetchFullPledgeStatement(companyId, pledge.accountId);
  const money = (amount: string) => safe(formatMoney(amount));
  const rows = ledger.items.map(line => `
    <tr>
      <td>${safe(line.documentDate)}</td>
      <td>${safe(line.documentNumber)}</td>
      <td>${safe(documentKindLabels[line.kind] ?? line.kind)}</td>
      <td class="description">${safe(line.description)}</td>
      <td class="num">${money(line.baseDebit)}</td>
      <td class="num">${money(line.baseCredit)}</td>
      <td class="num">${money(line.runningBalance)}</td>
    </tr>`).join("");
  const totals = ledger.totals;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
    <title>كشف حساب رهن - ${safe(pledge.customerName)}</title>
    <style>
      @page{size:A4 landscape;margin:12mm}
      *{box-sizing:border-box}body{font:12px/1.5 Arial,Tahoma,sans-serif;color:#111;margin:0}
      h1{font-size:21px;text-align:center;margin:0 0 12px}
      .meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 22px;margin-bottom:12px}
      .summary{display:flex;flex-wrap:wrap;gap:16px;margin:10px 0 15px;border-block:1px solid #aaa;padding:8px 0}
      table{border-collapse:collapse;width:100%;table-layout:fixed}
      th,td{border:1px solid #aaa;padding:5px 6px;text-align:right;vertical-align:top;overflow-wrap:anywhere}
      th{background:#eee}.description{width:34%}.num{direction:ltr;text-align:left;white-space:nowrap}
      thead{display:table-header-group}tr{break-inside:avoid}
      .actions{margin:0 0 12px}@media print{.actions{display:none}}
    </style></head><body>
    <div class="actions"><button type="button" onclick="window.print()">طباعة كشف الحساب</button></div>
    <h1>كشف حساب رهن</h1>
    <div class="meta">
      <span><b>اسم الحساب:</b> ${safe(ledger.account.name)}</span>
      <span><b>اسم صاحب الرهن:</b> ${safe(pledge.customerName)}</span>
      <span><b>الهاتف:</b> ${safe(pledge.phone)}</span>
      <span><b>وصف الرهن:</b> ${safe(pledge.collateral)}</span>
    </div>
    <div class="summary">
      <span><b>الرصيد الافتتاحي:</b> ${money(totals.openingBalance)}</span>
      <span><b>إجمالي المدين:</b> ${money(totals.debit)}</span>
      <span><b>إجمالي الدائن:</b> ${money(totals.credit)}</span>
      <span><b>الرصيد النهائي:</b> ${money(totals.closingBalance)}</span>
      <span><b>العملة:</b> ${safe(totals.baseCurrencyCode ?? "العملة الأساسية")}</span>
    </div>
    <table><thead><tr><th>التاريخ</th><th>المستند</th><th>النوع</th>
      <th class="description">البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">لا توجد حركات مالية لهذا الرهن.</td></tr>'}</tbody></table>
    </body></html>`;
  if (win.closed) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  // The blank window was opened in the direct user click; this prints in it
  // without navigating through the restricted account-ledger page.
  win.print();
}
