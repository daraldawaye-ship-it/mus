import { useEffect, useMemo, useRef, useState } from "react";
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
  isFriday: boolean;
  currencyCode: string;
  total: Row;
  hours: Row[];
};

const zero = (date: string, currencyCode: string): Row => ({
  date, currencyCode, hour: null, level: 1,
  invoiceCount: 0, returnInvoiceCount: 0,
  sales: "0", gross: "0", discount: "0", returns: "0", net: "0",
});
const weekdays = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
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

const firstSalesAverageDate = "2026-11-08";
const salesAverageDays = 7;
const salesAverageAmount = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1, maximumFractionDigits: 1,
});
const salesAverageWhole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const salesAverageDateLabel = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "2-digit", timeZone: "UTC",
});
const salesAverageShift = (date: string, days: number): string =>
  new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
function salesAverageValidDay(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date + "T00:00:00Z")) && salesAverageShift(date, 0) === date;
}
type SalesAveragePoint = { date: string; from: string; net: string; average: number };

function salesAveragePoints(rows: Row[], from: string, to: string, currency: string): SalesAveragePoint[] {
  const daily = new Map(rows.filter(row => row.level === 1 && row.date && row.currencyCode === currency)
    .map(row => [row.date, moneyUnits(row.net)]));
  const points: SalesAveragePoint[] = [];
  const lead = salesAverageShift(from, 1 - salesAverageDays);
  const window: bigint[] = [];
  let total = 0n;
  for (let date = lead; date <= to; date = salesAverageShift(date, 1)) {
    const amount = daily.get(date) ?? 0n;
    window.push(amount);
    total += amount;
    if (window.length > salesAverageDays) total -= window.shift()!;
    if (date < from) continue;
    const magnitude = total < 0 ? -total : total;
    const net = (total < 0 ? "-" : "") + (magnitude / 1000000n) +
      "." + String(magnitude % 1000000n).padStart(6, "0");
    points.push({ date, from: salesAverageShift(date, 1 - salesAverageDays),
      net, average: Number(total) / (1000000 * salesAverageDays) });
  }
  return points;
}

function SalesAverageLine({ points, currency }: { points: SalesAveragePoint[]; currency: string }) {
  const [activeDate, setActiveDate] = useState("");
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(900);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const sync = () => setChartWidth(Math.max(240, Math.round(chart.clientWidth || 900)));
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(chart);
    return () => observer.disconnect();
  }, [points.length]);
  if (!points.length) return null;
  const width = chartWidth, height = 280, left = width < 500 ? 76 : 97, right = width - 26;
  const top = 22, bottom = height - 47;
  const values = points.map(p => p.average);
  const min = values.reduce((low, value) => Math.min(low, value));
  const max = values.reduce((high, value) => Math.max(high, value));
  const guess = Math.max((max - min) / 4, Math.abs(max) * 0.015, 1);
  const order = 10 ** Math.floor(Math.log10(guess));
  const step = ([1, 2, 2.5, 5, 10].find(n => n * order >= guess) ?? 10) * order;
  const yMin = Math.floor(min / step) * step - (min === max ? step : 0);
  const yMax = Math.ceil(max / step) * step + (max === min ? step : 0);
  const x = (i: number) => points.length === 1 ? (left + right) / 2 :
    left + i * (right - left) / (points.length - 1);
  const y = (value: number) => bottom - (value - yMin) * (bottom - top) / (yMax - yMin);
  const activeIndex = points.findIndex(p => p.date === activeDate);
  const selected = activeIndex < 0 ? points.length - 1 : activeIndex;
  // Quadrant-preserving curves: stay between the adjacent measured values.
  const line = points.reduce((path, p, i) => {
    if (!i) return "M " + x(i) + "," + y(p.average);
    const mid = (x(i - 1) + x(i)) / 2;
    return path + " C " + mid + "," + y(points[i - 1].average) + " " + mid + "," +
      y(p.average) + " " + x(i) + "," + y(p.average);
  }, "");
  const dayTicks = Math.min(width < 500 ? 4 : 6, points.length);
  const tickIndices = Array.from({ length: dayTicks }, (_, i) =>
    dayTicks === 1 ? 0 : Math.round(i * (points.length - 1) / (dayTicks - 1)));
  const ticks = Array.from({ length: Math.round((yMax - yMin) / step) + 1 }, (_, i) => yMin + i * step);
  const selectedPoint = points[selected];
  return <>
    <p className="muted" aria-live="off">المعدل في <bdi>{selectedPoint.date}</bdi>:{" "}
      <strong dir="ltr">{salesAverageAmount.format(selectedPoint.average)} {currency}</strong></p>
    <div ref={chartRef} className="sales-average-graph" style={{ overflowX: "auto" }}>
      <svg role="img" aria-label="خط واحد يوضح المعدل اليومي لصافي آخر سبعة أيام" dir="ltr"
        viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", minWidth: 240 }}
        onPointerMove={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width || points.length < 2) return;
          const position = (event.clientX - rect.left) / rect.width * width;
          const index = Math.max(0, Math.min(points.length - 1,
            Math.round((position - left) / (right - left) * (points.length - 1))));
          setActiveDate(points[index].date);
        }} onPointerLeave={() => setActiveDate("")}>
        {ticks.map((value, i) => <g key={i} opacity=".65">
          <line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".18" />
          <text x={left - 8} y={y(value) + 4} textAnchor="end" fill="currentColor" fontSize="13">
            {salesAverageWhole.format(value)}
          </text>
        </g>)}
        {tickIndices.map(i => <text key={i} x={x(i)} y={bottom + 25} textAnchor="middle"
          fill="currentColor" opacity=".75" fontSize="13">
          {salesAverageDateLabel.format(new Date(points[i].date + "T00:00:00Z"))}
        </text>)}
        <path d={line} fill="none" stroke="#16a9d4" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (points.length <= 40 || i === selected) &&
          <circle key={p.date} cx={x(i)} cy={y(p.average)} r={i === selected ? 5 : 3} fill="#16a9d4">
            <title>{p.date} · {salesAverageAmount.format(p.average)} {currency}</title>
          </circle>)}
      </svg>
    </div>
  </>;
}

function SalesAverageReport({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [today, setToday] = useState(adenInvoiceToday);
  useEffect(() => {
    const sync = () => setToday(adenInvoiceToday());
    const timer = window.setInterval(sync, 30_000);
    window.addEventListener("focus", sync);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", sync); };
  }, []);
  const lastDate = salesAverageShift(today, -1);
  const defaultFrom = [firstSalesAverageDate, salesAverageShift(lastDate, -29)].sort()[1];
  const normalize = (value: string | null, fallback: string) =>
    value === "" ? "" : !value || !salesAverageValidDay(value) ? fallback :
      value < firstSalesAverageDate ? firstSalesAverageDate : value > lastDate ? lastDate : value;
  const from = normalize(params.get("averageFrom"), defaultFrom);
  const to = normalize(params.get("averageTo"), lastDate);
  const hasDays = lastDate >= firstSalesAverageDate;
  const valid = hasDays && !!from && !!to && from <= to;
  const lead = valid ? salesAverageShift(from, 1 - salesAverageDays) : "";
  const companyId = context.company.id;
  const report = useQuery({
    queryKey: ["sales-seven-day-average", user?.id, companyId, lead, to],
    queryFn: async ({ signal }) => {
      // Report API allows up to 366 days inclusive. Larger selections are read in adjacent chunks.
      let cursor = lead;
      const daily: Row[] = [];
      let currency = "";
      while (cursor <= to) {
        const cap = salesAverageShift(cursor, 365);
        const dateTo = cap < to ? cap : to;
        const request = new URLSearchParams({ dateFrom: cursor, dateTo, payment: "all" });
        const { report } = await api<{ report: Report }>(
          "/companies/" + companyId + "/sales-time-report?" + request, { signal });
        currency ||= report.baseCurrencyCode;
        daily.push(...report.rows.filter(row => row.level === 1));
        cursor = salesAverageShift(dateTo, 1);
      }
      return { daily, currency };
    },
    enabled: !!user && valid,
  });
  const data = valid ? report.data : undefined;
  const points = useMemo(() => data ? salesAveragePoints(data.daily, from, to, data.currency) : [], [data, from, to]);
  const change = (key: string, value: string) => setParams(previous => {
    const next = new URLSearchParams(previous); next.set(key, value); return next;
  });
  return <div id="sales-daily-average">
    <style>{'@media print { #sales-daily-average { display: none; } }'}</style>
    <Card title="المعدل اليومي للمبيعات"
      description="متوسط صافي آخر 7 أيام لكل تاريخ، بعد الخصم والمرتجعات. الافتراضي آخر 30 يومًا مكتملًا.">
      <div className="table-filters sales-time-report-filters">
        <Field label="من تاريخ" type="date" min={firstSalesAverageDate} max={lastDate}
          value={from} onChange={event => change("averageFrom", event.target.value)} />
        <Field label="إلى تاريخ" type="date" min={firstSalesAverageDate} max={lastDate}
          value={to} onChange={event => change("averageTo", event.target.value)} />
        <Button variant="secondary" disabled={!valid || report.isFetching}
          onClick={() => void report.refetch()}>تحديث</Button>
      </div>
      <p className="muted sales-time-note">
        اليوم الجاري لا يدخل في التقرير. آخر تاريخ متاح هو أمس بتوقيت عدن. يبدأ العرض من 8 نوفمبر 2026؛
        تُقرأ الأيام الستة السابقة لأول نقطة للحساب فقط.
      </p>
      {!valid && <Notice tone="warning">{hasDays ? "اختر فترة صحيحة تبدأ من 8 نوفمبر 2026 وتنتهي في أمس أو قبله." :
        "لا توجد أيام مكتملة متاحة للعرض بعد."}</Notice>}
      {valid && report.error && <Notice tone="error">{errorMessage(report.error)}</Notice>}
      {valid && report.isPending && <Notice>جارٍ احتساب المتوسطات…</Notice>}
    {data && <>
      <SalesAverageLine points={points} currency={data.currency} />
      <details>
        <summary>عرض الإجماليات والمعدلات اليومية</summary>
        <div className="table-scroll">
          <table className="sales-time-report-matrix">
            <thead><tr><th scope="col">التاريخ</th><th scope="col">الفترة</th>
              <th scope="col">صافي آخر 7 أيام ({data.currency})</th><th scope="col">المعدل اليومي</th></tr></thead>
            <tbody>{[...points].reverse().map(p => <tr key={p.date}>
              <td><bdi>{p.date}</bdi></td>
              <td><bdi>{p.from.slice(5).split("-").reverse().join("/")} – {p.date.slice(5).split("-").reverse().join("/")}</bdi></td>
              <td>{number(p.net)}</td><td><strong dir="ltr">{salesAverageAmount.format(p.average)}</strong></td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </>}
    </Card>
  </div>;
}

export function SalesTimeReportPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const today = adenInvoiceToday();
  const eightDaysAgo = new Date(Date.parse(today + "T00:00:00Z") - 8 * 86400000).toISOString().slice(0, 10);
  const dateFrom = params.get("dateFrom") ?? eightDaysAgo;
  const dateTo = params.get("dateTo") ?? today;
  const paymentParam = params.get("payment");
  const payment: Payment = paymentParam === "cash" || paymentParam === "credit"
    ? paymentParam : "all";
  const includeThirdParty = params.get("includeThirdParty") === "true";
  const weekdayParam = params.get("weekdays") ?? "0,1,2,3,4,5,6";
  const selectedWeekdays = weekdayParam.split(",").filter(value => /^[0-6]$/.test(value)).map(Number);
  const groupParam = params.get("group");
  const group: GroupHours = groupParam === "6" ? 6 : groupParam === "1" ? 1 : 3;
  const positions = useMemo(() =>
    Array.from({ length: 24 / group }, (_, index) => index * group), [group]);
  const daysBetween = (Date.parse(dateTo + "T00:00:00Z") -
    Date.parse(dateFrom + "T00:00:00Z")) / 86400000;
  const invalid = !dateFrom || !dateTo || dateFrom > dateTo ||
    !Number.isFinite(daysBetween) || daysBetween > 365;
  const query = new URLSearchParams({ dateFrom, dateTo, payment,
    includeThirdParty: String(includeThirdParty), weekdays: selectedWeekdays.join(",") });
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
      if (!selectedWeekdays.includes(new Date(time).getUTCDay())) continue;
      const date = new Date(time).toISOString().slice(0, 10);
      const found = daily.filter(row => row.date === date);
      const dayTotals = found.length ? found : [zero(date, data.baseCurrencyCode)];
      for (const total of dayTotals) {
        result.push({
          date,
          weekday: weekdayFormat.format(new Date(date + "T12:00:00Z")),
          isFriday: new Date(date + "T12:00:00Z").getUTCDay() === 5,
          currencyCode: total.currencyCode,
          total,
          hours: hourly.filter(row => row.date === date &&
            row.currencyCode === total.currencyCode),
        });
      }
    }
    return result;
  }, [data, weekdayParam]);
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
        <details className="sales-time-weekdays">
          <summary>أيام الأسبوع ({selectedWeekdays.length}/7)</summary>
          <div className="sales-time-weekday-menu">
            <label><input type="checkbox" checked={selectedWeekdays.length === 7}
              onChange={event => change("weekdays", event.target.checked ? "0,1,2,3,4,5,6" : "")} /> الكل</label>
            {weekdays.map((day, index) => <label key={day}>
              <input type="checkbox" checked={selectedWeekdays.includes(index)} onChange={event => {
                const next = event.target.checked ? [...selectedWeekdays, index]
                  : selectedWeekdays.filter(value => value !== index);
                change("weekdays", next.sort().join(","));
              }} /> {day}
            </label>)}
          </div>
        </details>
        <label className="sales-time-third-party"><input type="checkbox" checked={includeThirdParty}
          onChange={event => change("includeThirdParty", String(event.target.checked))} /> إظهار مبيعات أصناف الغير</label>
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
            <th>الخصم</th><th>المرتجعات</th><th>الصافي</th>
          </tr></thead>
          <tbody>
            {days.map(day => <tr key={day.date + ":" + day.currencyCode}
              className={day.isFriday ? "sales-time-friday" : undefined}>
              <td dir="ltr">{day.date}</td><td>{day.weekday}</td>
              {positions.map(start => <td key={start}>{number(slotTotal(day.hours, start))}</td>)}
              {showUnknown && <td>{number(unknownTotal(day.hours))}</td>}
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
    <SalesAverageReport context={context} />
  </div>;
}
