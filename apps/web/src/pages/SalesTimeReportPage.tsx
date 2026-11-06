import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Printer } from "lucide-react";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { adenInvoiceToday } from "../invoice-save-date";
import { formatWholeMoney } from "../format-money";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";
import "./SalesTimeReportPage.css";

type Payment = "all" | "cash" | "credit";
type GroupHours = 1 | 3 | 6;
type MoneyField = "gross" | "discount" | "returns" | "net";

type Row = {
  date: string | null;
  hour: number | null;
  currencyCode: string;
  level: number;
  invoiceCount: number;
  returnInvoiceCount: number;
  sales: string;
  gross: string;
  discount: string;
  returns: string;
  net: string;
};
type Report = {
  dateFrom: string;
  dateTo: string;
  payment: Payment;
  baseCurrencyCode: string;
  rows: Row[];
};
type DayRow = {
  date: string;
  weekday: string;
  currencyCode: string;
  total: Row;
  hours: Row[];
};

const zero = (date: string, currencyCode: string): Row => ({
  date, currencyCode, hour: null, level: 1,
  invoiceCount: 0, returnInvoiceCount: 0,
  sales: "0", gross: "0", discount: "0", returns: "0", net: "0",
});
const payments: Record<Payment, string> = {
  all: "الكل", cash: "النقد", credit: "الآجل",
};
const periodLabel = (start: number, interval: GroupHours): string =>
  String(start).padStart(2, "0") + "–" + String(start + interval).padStart(2, "0");

function moneyUnits(value: string): bigint {
  const negative = value.startsWith("-");
  const [integer, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const amount = BigInt(integer) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return negative ? -amount : amount;
}
function sumMoney(rows: Row[], key: MoneyField): string {
  const value = rows.reduce((total, row) => total + moneyUnits(row[key]), 0n);
  const abs = value < 0n ? -value : value;
  return (value < 0n ? "-" : "") + String(abs / 1000000n) +
    "." + String(abs % 1000000n).padStart(6, "0");
}
function formatted(value: string): string {
  // Hide fractions in daily report display; keep exact values in the API.
  return formatWholeMoney(value);
}
const number = (value: string) =>
  <span dir="ltr" className="sales-time-amount">{formatted(value)}</span>;
const weekdayFormat = new Intl.DateTimeFormat("ar-YE", {
  weekday: "long", timeZone: "UTC",
});

function exportCsv(
  filename: string, days: DayRow[], totals: Row[],
  positions: number[], interval: GroupHours, showUnknown: boolean,
) {
  const quote = (value: string) => {
    const safe = /^[\s]*[=+@-]/.test(value) && !/^-?\d+(?:\.\d+)?$/.test(value)
      ? "'" + value : value;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  const headers = [
    "التاريخ", "اليوم",
    ...positions.map(start => periodLabel(start, interval)),
    ...(showUnknown ? ["الوقت غير معروف"] : []),
    "الإجمالي قبل الخصم", "الخصم", "المرتجعات", "الصافي",
  ];
  const toRow = (date: string, weekday: string, hours: Row[], total: Row) => [
    date, weekday,
    ...positions.map(start => sumMoney(hours.filter(row =>
      row.hour !== null && row.hour >= start && row.hour < start + interval
    ), "gross")),
    ...(showUnknown ? [sumMoney(hours.filter(row => row.hour === null), "gross")] : []),
    total.gross, total.discount, total.returns, total.net,
  ];
  const hourly = days.flatMap(day =>
    [toRow(day.date, day.weekday, day.hours, day.total)]);
  const footer = totals.map(total => toRow("إجمالي الفترة", "",
    days.filter(day => day.currencyCode === total.currencyCode).flatMap(day => day.hours),
    total));
  const csv = "\uFEFF" + [headers, ...hourly, ...footer]
    .map(row => row.map((value, index) =>
      quote(index <= 1 ? String(value) : formatWholeMoney(value))).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename + ".csv";
  link.click();
  URL.revokeObjectURL(url);
}

export function SalesTimeReportPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const today = adenInvoiceToday();
  const dateFrom = params.get("dateFrom") ?? today;
  const dateTo = params.get("dateTo") ?? today;
  const paymentParam = params.get("payment");
  const payment: Payment = paymentParam === "cash" || paymentParam === "credit"
    ? paymentParam : "all";
  const groupParam = params.get("group");
  const group: GroupHours = groupParam === "3" ? 3 : groupParam === "1" ? 1 : 6;
  const positions = useMemo(() =>
    Array.from({ length: 24 / group }, (_, index) => index * group), [group]);
  const daysBetween = (Date.parse(dateTo + "T00:00:00Z") -
    Date.parse(dateFrom + "T00:00:00Z")) / 86400000;
  const invalid = !dateFrom || !dateTo || dateFrom > dateTo ||
    !Number.isFinite(daysBetween) || daysBetween > 365;
  const query = new URLSearchParams({ dateFrom, dateTo, payment });
  const report = useQuery({
    queryKey: ["sales-time-report", user?.id, companyId, query.toString()],
    queryFn: ({ signal }) => api<{ report: Report }>(
      "/companies/" + companyId + "/sales-time-report?" + query, { signal }),
    enabled: !!user && !invalid,
  });
  const data = invalid ? undefined : report.data?.report;
  const days = useMemo(() => {
    if (!data) return [] as DayRow[];
    const daily = data.rows.filter(row => row.level === 1);
    const hourly = data.rows.filter(row => row.level === 0);
    const result: DayRow[] = [];
    const end = Date.parse(data.dateTo + "T00:00:00Z");
    const start = Date.parse(data.dateFrom + "T00:00:00Z");
    for (let time = end; time >= start; time -= 86400000) {
      const date = new Date(time).toISOString().slice(0, 10);
      const found = daily.filter(row => row.date === date);
      const dayTotals = found.length ? found : [zero(date, data.baseCurrencyCode)];
      for (const total of dayTotals) {
        result.push({
          date,
          weekday: weekdayFormat.format(new Date(date + "T12:00:00Z")),
          currencyCode: total.currencyCode,
          total,
          hours: hourly.filter(row => row.date === date &&
            row.currencyCode === total.currencyCode),
        });
      }
    }
    return result;
  }, [data]);
  const totals = useMemo(() => {
    if (!data) return [] as Row[];
    const found = data.rows.filter(row => row.level === 3);
    return found.length ? found : [zero("", data.baseCurrencyCode)];
  }, [data]);
  const showUnknown = days.some(day => day.hours.some(row => row.hour === null));
  const change = (key: string, value: string) => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.set(key, value);
    return next;
  });
  const slotTotal = (hours: Row[], start: number): string =>
    sumMoney(hours.filter(row => row.hour !== null &&
      row.hour >= start && row.hour < start + group), "gross");
  const unknownTotal = (hours: Row[]): string =>
    sumMoney(hours.filter(row => row.hour === null), "gross");

  return <div className="ledger-page sales-time-report">
    <PageHeader title="مبيعات الأيام والأوقات"
      description="صف لكل يوم، والمبيعات موزعة إلى فترات زمنية قبل الخصم؛ خصم المبيعات والمرتجعات والصافي في الأعمدة الأخيرة."
      actions={<div className="sales-time-report-actions">
        <Button variant="secondary" disabled={!data} onClick={() => window.print()}>
          <Printer size={16} /> طباعة / PDF
        </Button>
        <Button variant="secondary" disabled={!data} onClick={() => {
          if (data) exportCsv("مبيعات-الأوقات-" + dateFrom + "-" + dateTo,
            days, totals, positions, group, showUnknown);
        }}>
          <FileSpreadsheet size={16} /> Excel (CSV)
        </Button>
      </div>} />
    <Card>
      <div className="table-filters sales-time-report-filters">
        <Field label="من تاريخ" type="date" value={dateFrom}
          onChange={event => change("dateFrom", event.target.value)} />
        <Field label="إلى تاريخ" type="date" value={dateTo}
          onChange={event => change("dateTo", event.target.value)} />
        <Select label="نوع المبيعات" value={payment}
          onChange={event => change("payment", event.target.value)}>
          <option value="all">{payments.all}</option>
          <option value="cash">{payments.cash}</option>
          <option value="credit">{payments.credit}</option>
        </Select>
        <Select label="التجميع الزمني" value={String(group)}
          onChange={event => change("group", event.target.value)}>
          <option value="6">كل 6 ساعات</option>
          <option value="3">كل 3 ساعات</option>
          <option value="1">تفصيل كل ساعة</option>
        </Select>
        <Button variant="secondary" disabled={invalid || report.isFetching}
          onClick={() => void report.refetch()}>تحديث</Button>
      </div>
      {invalid && <Notice tone="warning">اختر فترة صحيحة لا تتجاوز 366 يومًا.</Notice>}
      {report.error && <Notice tone="error">{errorMessage(report.error)}</Notice>}
      {report.isPending && !invalid && <Notice>جارٍ احتساب المبيعات…</Notice>}
      <p className="muted sales-time-note">
        الإجمالي = مجموع مبيعات الفترات قبل الخصم. الصافي = الإجمالي − الخصم − المرتجعات.
        المرتجعات صافية بعد الخصم الخاص بها، حتى لا يُخصم مرتين.
        الأوقات بتوقيت عدن، والفواتير التاريخية دون وقت موثوق تُعرض في عمود منفصل.
      </p>
    </Card>
    {data && <Card title={"التقرير من " + dateFrom + " إلى " + dateTo + " — " + payments[payment]}>
      <div className="table-scroll">
        <table className="sales-time-report-matrix">
          <thead><tr>
            <th>التاريخ</th><th>اليوم</th>
            {positions.map(start => <th key={start}>{periodLabel(start, group)}</th>)}
            {showUnknown && <th>وقت غير معروف</th>}
            <th>الإجمالي</th><th>الخصم</th><th>المرتجعات</th><th>الصافي</th>
          </tr></thead>
          <tbody>
            {days.map(day => <tr key={day.date + ":" + day.currencyCode}>
              <td dir="ltr">{day.date}</td><td>{day.weekday}</td>
              {positions.map(start => <td key={start}>{number(slotTotal(day.hours, start))}</td>)}
              {showUnknown && <td>{number(unknownTotal(day.hours))}</td>}
              <td>{number(day.total.gross)}</td>
              <td>{number(day.total.discount)}</td>
              <td>{number(day.total.returns)}</td>
              <td className="sales-time-net">{number(day.total.net)}</td>
            </tr>)}
          </tbody>
          <tfoot>
            {totals.map(total => {
              const allHours = days.filter(day => day.currencyCode === total.currencyCode)
                .flatMap(day => day.hours);
              return <tr key={total.currencyCode}>
                <th colSpan={2}>إجمالي الفترة</th>
                {positions.map(start => <th key={start}>{number(slotTotal(allHours, start))}</th>)}
                {showUnknown && <th>{number(unknownTotal(allHours))}</th>}
                <th>{number(total.gross)}</th>
                <th>{number(total.discount)}</th>
                <th>{number(total.returns)}</th>
                <th>{number(total.net)}</th>
              </tr>;
            })}
          </tfoot>
        </table>
      </div>
      <p className="muted sales-time-note">
        {days.length} صف يومي. عند عدم وجود مبيعات في يوم تظهر الأرقام صفرًا.
        {showUnknown ? " عمود «وقت غير معروف» يحافظ على إجمالي الفواتير القديمة دون نسبتها إلى ساعة غير مؤكدة." : ""}
      </p>
    </Card>}
  </div>;
}
