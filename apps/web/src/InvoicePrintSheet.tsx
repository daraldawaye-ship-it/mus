import type { CompanyContext, Invoice, InvoiceKind } from "../../../packages/contracts/src/index.ts";
import { formatMoney } from "./format-money";
import { CompanyPrintHeader } from "./CompanyPrintHeader";

/** Printed invoice columns are intentionally distinct from data-entry columns.
 * Purchase bonus is a reserved, blank print column until bonus entry exists.
 */
export function printedInvoiceColumns(kind: InvoiceKind): readonly string[] {
  return kind === "purchase"
    ? ["اسم الصنف", "الكمية", "الوحدة", "البونص", "السعر", "تاريخ الانتهاء", "القيمة"]
    : ["اسم الصنف", "الكمية", "الوحدة", "السعر", "القيمة"];
}
export function printedExpiry(value: string | null): string {
  return value ? value.slice(0, 7) : "—";
}
const money = (value: string) => <bdi dir="ltr">{formatMoney(value)}</bdi>;

export function InvoicePrintSheet({
  context, invoice, returning,
}: {
  context: CompanyContext;
  invoice: Invoice;
  returning: boolean;
}) {
  const purchase = invoice.kind === "purchase";
  const kindLabel = purchase ? "فاتورة مشتريات" : "فاتورة مبيعات";
  const columns = printedInvoiceColumns(invoice.kind);
  return (
    <section className={`invoice-print-sheet invoice-print-sheet--${invoice.kind}`} dir="rtl" aria-label="نسخة طباعة الفاتورة">
      <CompanyPrintHeader context={context} />
      <div className="invoice-print-caption">
        <h2>{returning ? "مردود " : ""}{kindLabel}</h2>
      </div>
      <dl className="invoice-print-details">
        <div><dt>رقم الفاتورة</dt><dd><bdi>{invoice.number}</bdi></dd></div>
        <div><dt>التاريخ</dt><dd><bdi dir="ltr">{invoice.documentDate}</bdi></dd></div>
        <div><dt>{purchase ? "المورد / الحساب" : "العميل / الحساب"}</dt>
          <dd>{invoice.counterpartyAccountName}</dd></div>
        <div><dt>رقم الحساب</dt><dd><bdi>{invoice.counterpartyAccountCode}</bdi></dd></div>
        {purchase && (
          <>
            <div><dt>رقم وصل المورد</dt><dd>{invoice.supplierReceiptNumber || "—"}</dd></div>
            {invoice.supplierAccountName && (
              <div><dt>المورد الفعلي</dt><dd>{invoice.supplierAccountName}</dd></div>
            )}
          </>
        )}
        <div><dt>الفرع</dt><dd>{invoice.branchName}</dd></div>
        <div><dt>الموقع</dt><dd>{invoice.locationName}</dd></div>
        {invoice.doctorName && <div><dt>الطبيب / الجهة</dt><dd>{invoice.doctorName}</dd></div>}
        <div><dt>العملة</dt><dd>{invoice.currencyCode}</dd></div>
      </dl>
      {invoice.description && (
        <div className="invoice-print-notes">
          <strong>ملاحظات:</strong> {invoice.description}
        </div>
      )}
      <table className="invoice-print-matrix">
        <colgroup>
          <col className="invoice-print-col-item" />
          <col className="invoice-print-col-qty" />
          <col className="invoice-print-col-unit" />
          {purchase && <col className="invoice-print-col-bonus" />}
          <col className="invoice-print-col-price" />
          {purchase && <col className="invoice-print-col-expiry" />}
          <col className="invoice-print-col-total" />
        </colgroup>
        <thead>
          <tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>
          {invoice.lines.map(line => (
            <tr key={line.id}>
              <td className="invoice-print-item">{line.itemName}</td>
              <td className="invoice-print-number">{money(line.quantity)}</td>
              <td>{line.unitName}</td>
              {purchase && <td className="invoice-print-number">—</td>}
              <td className="invoice-print-number">{money(line.unitPrice)}</td>
              {purchase && <td className="invoice-print-expiry"><bdi dir="ltr">{printedExpiry(line.expiryDate)}</bdi></td>}
              <td className="invoice-print-number">{money(line.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="invoice-print-summary">
        <div><span>الإجمالي قبل الخصم</span><strong>{money(invoice.gross)}</strong></div>
        <div><span>الخصم</span><strong>{money(invoice.discount)}</strong></div>
        <div className="invoice-print-net"><span>الصافي ({invoice.currencyCode})</span>
          <strong>{money(invoice.total)}</strong></div>
      </div>
      <div className="invoice-print-acknowledgements">
        <div><strong>أُعدّت بواسطة: {invoice.createdByName}</strong>
          <span>التوقيع: __________________</span></div>
        <div><strong>المستلم</strong>
          <span>الاسم: __________________</span>
          <span>التوقيع: __________________</span></div>
      </div>
      <div className="invoice-print-timestamp">
        وقت الإصدار: <bdi dir="ltr">{new Date(invoice.createdAt).toLocaleString("en-GB", {
          timeZone: "Asia/Aden", hour12: false,
        })}</bdi>
      </div>
    </section>
  );
}
