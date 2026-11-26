import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { formatMoney } from "../format-money";
import { adenInvoiceToday } from "../invoice-save-date";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { Card, Field, Notice, PageHeader } from "../ui";

const title = "إجمالي سداد الأطباء والممرضين";
const columns = [
  ["name", "الاسم الرئيسي"],
  ["direct", "السداد المباشر"],
  ["custody", "الصرف من العهدة"],
  ["total", "الإجمالي"],
] as const;
type Sort = typeof columns[number][0];
type Amounts = { directAmount: string; custodyAmount: string; totalAmount: string };
type Report = { currencyCode: string; totals: Amounts;
  items: Array<Amounts & { name: string; kinds: Array<"doctor"|"nurse"> }> };
const labels = { doctor: "طبيب", nurse: "ممرض" };

function AmountCells({ amount }: { amount: Amounts }) {
  return <>
    <td><bdi className="financial-number">{formatMoney(amount.directAmount)}</bdi></td>
    <td><bdi className="financial-number">{formatMoney(amount.custodyAmount)}</bdi></td>
    <td><bdi className="financial-number">{formatMoney(amount.totalAmount)}</bdi></td>
  </>;
}

export function MedicalPaymentSummaryPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const directory = usePageDirectory(companyId);
  const access = directory.data?.find(entry => entry.key === "company.medical-payment-summary");
  const allowed = !!access?.enabled && !!access.actionAccess.view;
  const now = new Date();
  const today = adenInvoiceToday(now);
  const minDate = adenInvoiceToday(new Date(now.getTime() - 10 * 86_400_000));
  const [dateFrom, setFrom] = useState(today);
  const [dateTo, setTo] = useState(today);
  const [order, setOrder] = useState<{ sort: Sort; direction: "asc"|"desc" }>({ sort: "total", direction: "desc" });
  const valid = !!dateFrom && !!dateTo && dateFrom >= minDate && dateFrom <= dateTo && dateTo <= today;
  const query = new URLSearchParams({ dateFrom, dateTo, ...order }).toString();
  const report = useQuery({
    queryKey: ["medical-payment-summary", user?.id, companyId, query],
    queryFn: ({ signal }) => api<{ report: Report }>(
      `/companies/${companyId}/medical-payment-summary?${query}`, { signal }),
    enabled: !!user && allowed && valid,
    refetchOnWindowFocus: "always",
  });
  const data = report.data?.report;

  return <>
    <PageHeader title={title} />
    {directory.isPending && <Notice>جارٍ التحقق من الصلاحيات…</Notice>}
    {!directory.isPending && !allowed && <Notice tone="warning">لا تملك صلاحية عرض هذا التقرير.</Notice>}
    {allowed && <>
      <Card>
        <div className="form-grid">
          <Field label="من تاريخ" type="date" value={dateFrom} min={minDate} max={today}
            onChange={event => setFrom(event.target.value)} />
          <Field label="إلى تاريخ" type="date" value={dateTo} min={minDate} max={today}
            onChange={event => setTo(event.target.value)} />
        </div>
        {!valid && <Notice tone="warning">اختر فترة بين {minDate} و{today}، على ألا يتجاوز «من تاريخ» تاريخ النهاية.</Notice>}
      </Card>
      {valid && report.isPending && <Notice>جارٍ تحميل الإجماليات…</Notice>}
      {valid && report.error && <Notice tone="error">{errorMessage(report.error)}</Notice>}
      {valid && data && <Card>
        <div className="table-scroll">
          <table>
            <caption>المبالغ بالريال اليمني، بدون القصاصات</caption>
            <thead><tr>{columns.map(([key, label]) =>
              <th key={key} scope="col" aria-sort={order.sort !== key ? "none" : order.direction === "asc" ? "ascending" : "descending"}>
                <button type="button" className="button secondary compact" onClick={() => setOrder(previous => ({
                  sort: key, direction: previous.sort === key ? (previous.direction === "asc" ? "desc" : "asc")
                    : key === "name" ? "asc" : "desc",
                }))}>{label}{order.sort === key ? (order.direction === "asc" ? " ↑" : " ↓") : ""}</button>
              </th>)}</tr></thead>
            <tbody>{data.items.length ? data.items.map(row => <tr key={row.name}>
              <th scope="row">{row.name} <small>({row.kinds.map(kind => labels[kind]).join("، ")})</small></th>
              <AmountCells amount={row}/>
            </tr>) : <tr><td colSpan={columns.length}>لا توجد مبالغ سداد في الفترة المحددة.</td></tr>}</tbody>
            <tfoot><tr><th scope="row">إجمالي الفترة</th><AmountCells amount={data.totals}/></tr></tfoot>
          </table>
        </div>
      </Card>}
    </>}
  </>;
}
