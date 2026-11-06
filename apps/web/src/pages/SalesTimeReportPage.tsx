import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Printer } from "lucide-react";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { adenInvoiceToday } from "../invoice-save-date";
import { formatMoney } from "../format-money";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

type Row = {
  date: string | null;
  hour: number | null;
  currencyCode: string;
  level: number;
  invoiceCount: number;
  returnInvoiceCount: number;
  sales: string;
  returns: string;
  net: string;
};
type Report = {
  dateFrom: string;
  dateTo: string;
  payment: "all" | "cash" | "credit";
  baseCurrencyCode: string;
  rows: Row[];
};
const zero = (date: string, currencyCode: string): Row => ({
  date, currencyCode, hour: null, level: 1,
  invoiceCount: 0, returnInvoiceCount: 0, sales: "0", returns: "0", net: "0",
});
const cashLabels = { all: "الكل", cash: "النقد", credit: "الآجل" };
const amount = (value: string) => <bdi>{formatMoney(value)}</bdi>;
const timeLabel = (hour: number | null) => hour === null
  ? "وقت غير معروف (فاتورة تاريخية)"
  : String(hour).padStart(2, "0") + ":00 – " + String((hour + 1) % 24).padStart(2, "0") + ":00";

function exportCsv(name: string, report: Report) {
  const quote = (v: string | number) => {
    const raw = String(v);
    const safe = /^[\s]*[=+@-]/.test(raw) && !/^-?\d+(?:\.\d+)?$/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  const headers = ["التاريخ", "الوقت", "العملة الأساسية", "الفواتير", "فواتير المردود", "المبيعات", "المرتجعات", "الصافي"];
  const lines = report.rows.filter(row => row.level !== 3).map(row => [
    row.date ?? "", row.level === 1 ? "إجمالي اليوم" : timeLabel(row.hour),
    row.currencyCode, row.invoiceCount, row.returnInvoiceCount,
    row.sales, row.returns, row.net,
  ]);
  const csv = "\uFEFF" + [headers, ...lines].map(line => line.map(quote).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name + ".csv"; a.click();
  URL.revokeObjectURL(url);
}

export function SalesTimeReportPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const today = adenInvoiceToday();
  const dateFrom = params.get("dateFrom") ?? today;
  const dateTo = params.get("dateTo") ?? today;
  const paymentInput = params.get("payment");
  const payment = paymentInput === "cash" || paymentInput === "credit" ? paymentInput : "all";
  const daysBetween = (Date.parse(dateTo + "T00:00:00Z") - Date.parse(dateFrom + "T00:00:00Z")) / 86400000;
  const invalid = !dateFrom || !dateTo || dateFrom > dateTo || !Number.isFinite(daysBetween) || daysBetween > 365;
  const query = new URLSearchParams({ dateFrom, dateTo, payment });
  const report = useQuery({
    queryKey: ["sales-time-report", user?.id, companyId, query.toString()],
    queryFn: ({ signal }) => api<{ report: Report }>(
      "/companies/" + companyId + "/sales-time-report?" + query, { signal }),
    enabled: !!user && !invalid,
  });
  const data = report.data?.report;
  const days = useMemo(() => {
    if (!data) return [] as { date: string; totals: Row[]; hours: Row[] }[];
    const dailyRows = data.rows.filter(row => row.level === 1);
    const hourlyRows = data.rows.filter(row => row.level === 0);
    const result: { date: string; totals: Row[]; hours: Row[] }[] = [];
    const end = Date.parse(data.dateTo + "T00:00:00Z");
    const start = Date.parse(data.dateFrom + "T00:00:00Z");
    for (let t = end; t >= start; t -= 86400000) {
      const date = new Date(t).toISOString().slice(0, 10);
      const totals = dailyRows.filter(row => row.date === date);
      result.push({
        date,
        totals: totals.length ? totals : [zero(date, data.baseCurrencyCode)],
        hours: hourlyRows.filter(row => row.date === date),
      });
    }
    return result;
  }, [data]);
  const totals = data?.rows.filter(row => row.level === 3) ?? [];
  const grand = totals.length ? totals : data ? [zero("", data.baseCurrencyCode)] : [];
  const change = (key: string, value: string) => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.set(key, value);
    return next;
  });

  return <div className="ledger-page">
    <PageHeader title="تقرير المبيعات حسب الأيام والأوقات"
      description="مبيعات كل يوم حسب الساعة، والمردودات والصافي بعد الخصومات؛ النقد والآجل بحسب الحساب المقابل للفاتورة."
      actions={<>
        <Button variant="secondary" disabled={!data} onClick={() => window.print()}><Printer size={16} /> طباعة / PDF</Button>
        <Button variant="secondary" disabled={!data} onClick={() => { if (data) exportCsv("مبيعات-الأيام-والأوقات-" + dateFrom + "-" + dateTo, data); }}>
          <FileSpreadsheet size={16} /> Excel (CSV)
        </Button>
      </>} />
    <Card>
      <div className="table-filters">
        <Field label="من تاريخ" type="date" value={dateFrom} onChange={event => change("dateFrom", event.target.value)} />
        <Field label="إلى تاريخ" type="date" value={dateTo} onChange={event => change("dateTo", event.target.value)} />
        <Select label="نوع المبيعات" value={payment} onChange={event => change("payment", event.target.value)}>
          <option value="all">{cashLabels.all}</option>
          <option value="cash">{cashLabels.cash}</option>
          <option value="credit">{cashLabels.credit}</option>
        </Select>
        <Button variant="secondary" disabled={report.isFetching || invalid} onClick={() => void report.refetch()}>تحديث</Button>
      </div>
      {invalid && <Notice tone="warning">اختر تاريخين صحيحين؛ لا تتجاوز الفترة 366 يومًا.</Notice>}
      {report.error && <Notice tone="error">{errorMessage(report.error)}</Notice>}
      {report.isPending && !invalid && <Notice>جارٍ احتساب المبيعات والمرتجعات…</Notice>}
      <p className="muted">الوقت بتوقيت عدن من ساعة حفظ الفاتورة. الفواتير التاريخية التي لا يتطابق يوم إدخالها مع تاريخها تظهر بوقت غير معروف، بدل عرض وقت الاستيراد على أنه وقت البيع.</p>
    </Card>
    {data && <>
      <Card title="إجمالي الفترة">
        <div className="table-scroll"><table>
          <thead><tr><th>العملة الأساسية</th><th>عدد الفواتير</th><th>فواتير المردود</th><th>إجمالي المبيعات</th><th>المرتجعات</th><th>صافي المبيعات</th></tr></thead>
          <tbody>{grand.map(row => <tr key={row.currencyCode}>
            <td>{row.currencyCode || "—"}</td>
            <td>{row.invoiceCount}</td><td>{row.returnInvoiceCount}</td>
            <td>{amount(row.sales)}</td><td>{amount(row.returns)}</td><td><strong>{amount(row.net)}</strong></td>
          </tr>)}</tbody>
        </table></div>
      </Card>
      <Card title={"المبيعات اليومية (" + days.length + " يومًا)"}>
        <div className="table-scroll"><table>
          <thead><tr><th>اليوم</th><th>العملة</th><th>الفواتير</th><th>المردود</th><th>المبيعات</th><th>المرتجعات</th><th>الصافي</th></tr></thead>
          <tbody>{days.flatMap(day => day.totals.map(row => <tr key={day.date + ":" + row.currencyCode}>
            <td><strong>{day.date}</strong></td><td>{row.currencyCode || "—"}</td>
            <td>{row.invoiceCount}</td><td>{row.returnInvoiceCount}</td>
            <td>{amount(row.sales)}</td><td>{amount(row.returns)}</td><td><strong>{amount(row.net)}</strong></td>
          </tr>))}</tbody>
        </table></div>
      </Card>
      <Card title="تفصيل ساعات كل يوم">
        {days.map((day, index) => <details key={day.date} open={index === 0}>
          <summary><strong>{day.date}</strong> — {day.hours.length ? day.hours.length + " فترة" : "لا توجد مبيعات"}</summary>
          {day.hours.length > 0 && <div className="table-scroll"><table>
            <thead><tr><th>الوقت</th><th>العملة</th><th>الفواتير</th><th>فواتير المردود</th><th>المبيعات</th><th>المرتجعات</th><th>الصافي</th></tr></thead>
            <tbody>{day.hours.map(row => <tr key={day.date + ":" + row.hour + ":" + row.currencyCode}>
              <td>{timeLabel(row.hour)}</td><td>{row.currencyCode}</td>
              <td>{row.invoiceCount}</td><td>{row.returnInvoiceCount}</td>
              <td>{amount(row.sales)}</td><td>{amount(row.returns)}</td><td><strong>{amount(row.net)}</strong></td>
            </tr>)}</tbody>
          </table></div>}
        </details>)}
      </Card>
    </>}
  </div>;
}
