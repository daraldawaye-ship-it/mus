import type { CompanyContext } from "../../../packages/contracts/src/index";
import { documentKindLabels } from "../../../packages/contracts/src/index";
import { CompanyPrintHeader } from "./CompanyPrintHeader";
import { formatMoney } from "./format-money";
import type { PledgeStatementData } from "./pledge-statement-print";

export type PrintablePledge = {
  accountId: number;
  customerName: string;
  collateral: string;
};

export function PledgeStatementPrint({
  context,
  pledge,
  statement,
  onLetterheadReady,
}: {
  context: CompanyContext;
  pledge: PrintablePledge;
  statement: PledgeStatementData;
  onLetterheadReady: () => void;
}) {
  const money = (value: string) => formatMoney(value);
  const { totals, items } = statement;
  return (
    <div className="pledge-statement-print" dir="rtl" aria-label="كشف الرهن للطباعة">
      <CompanyPrintHeader context={context} onReady={onLetterheadReady} />
      <h2>كشف حساب رهن</h2>
      <div className="pledge-statement-print-info">
        <div><strong>صاحب الرهن:</strong> {pledge.customerName}</div>
        <div><strong>وصف الرهن:</strong> {pledge.collateral}</div>
      </div>
      <div className="pledge-statement-print-totals">
        <span><strong>الرصيد الافتتاحي:</strong> {money(totals.openingBalance)}</span>
        <span><strong>إجمالي المدين:</strong> {money(totals.debit)}</span>
        <span><strong>إجمالي الدائن:</strong> {money(totals.credit)}</span>
        <span><strong>الرصيد النهائي:</strong> {money(totals.closingBalance)}</span>
        <span><strong>العملة:</strong> {totals.baseCurrencyCode ?? "العملة الأساسية"}</span>
      </div>
      <table className="pledge-statement-print-table">
        <thead>
          <tr>
            <th>التاريخ</th>
            <th>النوع</th>
            <th>البيان</th>
            <th>مدين</th>
            <th>دائن</th>
            <th>الرصيد</th>
          </tr>
        </thead>
        <tbody>
          {items.map((line, i) => (
            <tr key={`${line.documentId}:${line.id}:${i}`}>
              <td dir="ltr">{line.documentDate}</td>
              <td>{documentKindLabels[line.kind] ?? line.kind}</td>
              <td className="pledge-statement-print-description">{line.description}</td>
              <td className="pledge-statement-print-number">{money(line.baseDebit)}</td>
              <td className="pledge-statement-print-number">{money(line.baseCredit)}</td>
              <td className="pledge-statement-print-number">{money(line.runningBalance)}</td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={6}>لا توجد حركات مالية لهذا الرهن.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
