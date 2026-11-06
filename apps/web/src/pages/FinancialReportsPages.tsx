import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Printer, FileSpreadsheet } from "lucide-react";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { CompanyPrintHeader } from "../CompanyPrintHeader";
import { formatMoney } from "../format-money";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

type Figures = {
  openingDebit: string; openingCredit: string; debit: string; credit: string;
  closingDebit: string; closingCredit: string;
};
type BalanceRow = Figures & {
  id: number; parentId: number | null; code: string; name: string;
  kind: string; category: string; hasMovement: boolean;
};
type TrialResponse = {
  dateFrom: string | null; dateTo: string | null; currencyCode: string;
  items: BalanceRow[]; totals: Figures; balanced: boolean;
};
type ActivityName = "operating" | "investing" | "financing" | "unclassified";
type FlowAmounts = { incoming: string; outgoing: string };
type FlowRow = FlowAmounts & {
  id: number; number: string; kind: string; description: string;
  date: string; counterpart: string; activity: ActivityName;
};
type FlowResponse = {
  dateFrom: string | null; dateTo: string | null; currencyCode: string;
  opening: string; incoming: string; outgoing: string; closing: string;
  total: number; page: number; pageSize: number;
  activities: Record<ActivityName, FlowAmounts>; items: FlowRow[];
};
const activityLabels: Record<ActivityName, string> = {
  operating: "التدفقات التشغيلية", investing: "التدفقات الاستثمارية",
  financing: "التدفقات التمويلية", unclassified: "حركات لم تُصنف بعد",
};
const kindLabels: Record<string, string> = {
  journal: "قيد", receipt: "قبض", payment: "صرف",
};
const money = (value: string) => <bdi className="financial-number">{formatMoney(value)}</bdi>;

function adenToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (key: string) => parts.find((value) => value.type === key)?.value ?? "";
  return part("year") + "-" + part("month") + "-" + part("day");
}

function useReportDates() {
  const [params, setParams] = useSearchParams();
  const today = adenToday();
  const dateFrom = params.has("dateFrom") ? params.get("dateFrom") ?? "" : today;
  const dateTo = params.has("dateTo") ? params.get("dateTo") ?? "" : today;
  const invalid = Boolean(dateFrom && dateTo && dateFrom > dateTo);
  const change = (key: string, value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set(key, value);
    if (key !== "page") next.delete("page");
    return next;
  });
  const query = new URLSearchParams({ dateFrom, dateTo });
  return { params, dateFrom, dateTo, invalid, change, query };
}

function PeriodFields({ dateFrom, dateTo, change }: {
  dateFrom: string; dateTo: string; change: (key: string, value: string) => void;
}) {
  return <div className="table-filters">
    <Field label="من تاريخ" type="date" value={dateFrom}
      onChange={(event) => change("dateFrom", event.target.value)} />
    <Field label="إلى تاريخ" type="date" value={dateTo}
      onChange={(event) => change("dateTo", event.target.value)} />
  </div>;
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  // Quote spreadsheet formulas in imported names or descriptions.
  const quote = (value: string | number) => {
    const text = String(value);
    const safe = /^[\s]*[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text) ? "'" + text : text;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  const csv = "\uFEFF" + [headers, ...rows].map((row) => row.map(quote).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename + ".csv";
  link.click();
  URL.revokeObjectURL(url);
}

function ReportActions({ onExport, disabled }: { onExport: () => void; disabled: boolean }) {
  return <>
    <Button variant="secondary" disabled={disabled} onClick={() => window.print()}>
      <Printer size={16} /> طباعة / PDF
    </Button>
    <Button variant="secondary" disabled={disabled} onClick={onExport}>
      <FileSpreadsheet size={16} /> Excel (CSV)
    </Button>
  </>;
}

export function TrialBalancePage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const { dateFrom, dateTo, invalid, change, query } = useReportDates();
  const [search, setSearch] = useState("");
  const [display, setDisplay] = useState("posting");
  const [hideZero, setHideZero] = useState(false);
  const [page, setPage] = useState(1);
  const companyId = context.company.id;
  const report = useQuery({
    queryKey: ["owner-trial-balance", user?.id, companyId, query.toString()],
    queryFn: ({ signal }) => api<TrialResponse>(
      "/companies/" + companyId + "/trial-balance?" + query, { signal }),
    enabled: !!user?.owner && !invalid,
  });
  const items = useMemo(() => (report.data?.items ?? []).filter((row) => {
    if (display !== "all" && row.kind !== display) return false;
    if (hideZero && row.openingDebit === "0" && row.openingCredit === "0" &&
      row.debit === "0" && row.credit === "0" &&
      row.closingDebit === "0" && row.closingCredit === "0") return false;
    const needle = search.trim().toLowerCase();
    return !needle || (row.code + " " + row.name).toLowerCase().includes(needle);
  }), [report.data, search, display, hideZero]);
  const pageSize = 100;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / pageSize)));
  const shown = items.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  if (!user?.owner) return <Notice tone="error">ميزان المراجعة متاح لمالك المنصة فقط.</Notice>;
  const headings = ["رقم الحساب", "اسم الحساب", "افتتاحي مدين", "افتتاحي دائن", "حركة مدين", "حركة دائن", "ختامي مدين", "ختامي دائن"];
  const exportData = () => downloadCsv("ميزان-المراجعة-" + dateFrom + "-" + dateTo, headings,
    items.map((row) => [row.code, row.name, row.openingDebit, row.openingCredit,
      row.debit, row.credit, row.closingDebit, row.closingCredit]));
  return <div className="ledger-page">
    <div className="ledger-print-heading"><CompanyPrintHeader context={context} />
      <h2>ميزان المراجعة — {dateFrom || "البداية"} إلى {dateTo || "اليوم"}</h2></div>
    <PageHeader title="ميزان المراجعة"
      description={"الافتتاحي وحركة الفترة والختامي بالعملة الأساسية: " + (report.data?.currencyCode || "—") + ". من القيود المرحلة فقط."}
      actions={<ReportActions disabled={!report.data || invalid} onExport={exportData} />} />
    <Card>
      <PeriodFields dateFrom={dateFrom} dateTo={dateTo} change={(key, value) => { change(key, value); setPage(1); }} />
      <div className="table-filters">
        <Field label="ابحث عن حساب بالاسم أو الرقم" type="search" value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
        <Select label="نوع الحسابات" value={display} onChange={(event) => { setDisplay(event.target.value); setPage(1); }}>
          <option value="posting">الحسابات الحركية</option>
          <option value="group">الحسابات الرئيسية</option>
          <option value="all">جميع الحسابات</option>
        </Select>
        <label className="field">
          <span>إخفاء الحسابات الصفرية</span>
          <input type="checkbox" checked={hideZero} onChange={(event) => { setHideZero(event.target.checked); setPage(1); }} />
        </label>
      </div>
      {invalid && <Notice tone="error">تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.</Notice>}
      {report.error && <Notice tone="error">{errorMessage(report.error)}</Notice>}
      {report.isPending && !invalid && <Notice>جارٍ احتساب ميزان المراجعة…</Notice>}
      {report.data && <>
        {!report.data.balanced &&
          <Notice tone="warning">يوجد فرق بين إجماليات القيود أو أرصدة الحسابات؛ يلزم مراجعة الترحيلات قبل الاعتماد.</Notice>}
        <p>الحسابات المطابقة: {items.length} — الصفحة {currentPage} من {Math.max(1, Math.ceil(items.length / pageSize))}</p>
        <div className="table-scroll"><table>
          <thead><tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead>
          <tbody>
            {shown.map((row) => <tr key={row.id}>
              <td>{row.code}</td>
              <td>{row.kind === "posting" ?
                <Link to={"/companies/" + companyId + "/account-ledger?accountId=" + row.id + "&dateFrom=" + dateFrom + "&dateTo=" + dateTo}>{row.name}</Link>
                : <strong>{row.name}</strong>}</td>
              <td>{money(row.openingDebit)}</td><td>{money(row.openingCredit)}</td>
              <td>{money(row.debit)}</td><td>{money(row.credit)}</td>
              <td>{money(row.closingDebit)}</td><td>{money(row.closingCredit)}</td>
            </tr>)}
            {!shown.length && <tr><td colSpan={8}>لا توجد حسابات مطابقة.</td></tr>}
          </tbody>
          <tfoot><tr><th colSpan={2}>إجمالي الحسابات الحركية (كل النتائج)</th>
            <th>{money(report.data.totals.openingDebit)}</th><th>{money(report.data.totals.openingCredit)}</th>
            <th>{money(report.data.totals.debit)}</th><th>{money(report.data.totals.credit)}</th>
            <th>{money(report.data.totals.closingDebit)}</th><th>{money(report.data.totals.closingCredit)}</th>
          </tr></tfoot>
        </table></div>
        <div className="form-actions">
          <Button variant="secondary" disabled={currentPage <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}>السابق</Button>
          <span>صفحة {currentPage}</span>
          <Button variant="secondary" disabled={currentPage * pageSize >= items.length}
            onClick={() => setPage((value) => value + 1)}>التالي</Button>
        </div>
      </>}
    </Card>
  </div>;
}

export function CashFlowsPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const { params, dateFrom, dateTo, invalid, change, query } = useReportDates();
  const companyId = context.company.id;
  const page = Math.max(1, Number(params.get("page")) || 1);
  query.set("page", String(page));
  const report = useQuery({
    queryKey: ["owner-cash-flows", user?.id, companyId, query.toString()],
    queryFn: ({ signal }) => api<FlowResponse>(
      "/companies/" + companyId + "/cash-flows?" + query, { signal }),
    enabled: !!user?.owner && !invalid,
  });
  if (!user?.owner) return <Notice tone="error">التدفقات المالية متاحة لمالك المنصة فقط.</Notice>;
  const data = report.data;
  const activityEntries = Object.entries(activityLabels) as [ActivityName, string][];
  const exportData = () => {
    if (!data) return;
    downloadCsv("التدفقات-المالية-" + dateFrom + "-" + dateTo + "-صفحة-" + page,
      ["التاريخ", "المستند", "النوع", "البيان", "الحسابات المقابلة", "التصنيف", "داخل", "خارج"],
      data.items.map((row) => [row.date, row.number, kindLabels[row.kind] ?? row.kind,
        row.description, row.counterpart, activityLabels[row.activity], row.incoming, row.outgoing]));
  };
  return <div className="ledger-page">
    <div className="ledger-print-heading"><CompanyPrintHeader context={context} />
      <h2>التدفقات المالية — {dateFrom || "البداية"} إلى {dateTo || "اليوم"}</h2></div>
    <PageHeader title="التدفقات المالية (النقدية)"
      description={"تغير النقد بالصناديق والبنوك المعلّمة نقدية، بالعملة الأساسية " + (data?.currencyCode || "—") + "؛ التحويلات الداخلية لا تُضاعف التدفق."}
      actions={<ReportActions disabled={!data || invalid} onExport={exportData} />} />
    <Card>
      <PeriodFields dateFrom={dateFrom} dateTo={dateTo} change={change} />
      {invalid && <Notice tone="error">تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.</Notice>}
      {report.error && <Notice tone="error">{errorMessage(report.error)}</Notice>}
      {report.isPending && !invalid && <Notice>جارٍ احتساب التدفقات النقدية…</Notice>}
      {data && <>
        <div className="financial-totals">
          <span>رصيد أول الفترة: {money(data.opening)}</span>
          <span>التدفقات الداخلة: {money(data.incoming)}</span>
          <span>التدفقات الخارجة: {money(data.outgoing)}</span>
          <strong>رصيد نهاية الفترة: {money(data.closing)} {data.currencyCode}</strong>
        </div>
        <h3>ملخص الأنشطة</h3>
        <div className="table-scroll"><table>
          <thead><tr><th>التصنيف</th><th>داخل</th><th>خارج</th></tr></thead>
          <tbody>{activityEntries.map(([key, label]) => <tr key={key}>
            <td>{label}</td>
            <td>{money(data.activities[key]?.incoming ?? "0")}</td>
            <td>{money(data.activities[key]?.outgoing ?? "0")}</td>
          </tr>)}</tbody>
          <tfoot><tr><th>الإجمالي</th><th>{money(data.incoming)}</th><th>{money(data.outgoing)}</th></tr></tfoot>
        </table></div>
        <Notice>تصنيف النشاط تحفظي: حسابات الإيرادات والمصروفات تشغيلية وحقوق الملكية تمويلية؛ الالتزامات والأصول الأخرى تظهر «لم تُصنف بعد» حتى لا تُفسر تحصيلات العملاء أو الموردين على أنها استثمارات أو قروض. التحويلات بين الحسابات النقدية لا تظهر كتحصيل أو صرف للشركة.</Notice>
        <h3>الحركات النقدية خلال الفترة</h3>
        <p>عدد الحركات: {data.total} — الصفحة {page} من {Math.max(1, Math.ceil(data.total / data.pageSize))}؛ تنزيل Excel يشمل الصفحة المعروضة.</p>
        <div className="table-scroll"><table>
          <thead><tr><th>التاريخ</th><th>المستند</th><th>النوع</th><th>البيان</th><th>الحساب المقابل</th><th>التصنيف</th><th>داخل</th><th>خارج</th></tr></thead>
          <tbody>
            {data.items.map((row) => <tr key={row.id}>
              <td>{row.date}</td><td><Link to={"/companies/" + companyId + "/financial-documents/" + row.id}>{row.number}</Link></td>
              <td>{kindLabels[row.kind] ?? row.kind}</td><td>{row.description || "—"}</td>
              <td>{row.counterpart || "—"}</td><td>{activityLabels[row.activity] ?? "غير مصنف"}</td>
              <td>{money(row.incoming)}</td><td>{money(row.outgoing)}</td>
            </tr>)}
            {!data.items.length && <tr><td colSpan={8}>لا توجد تدفقات نقدية في هذه الفترة.</td></tr>}
          </tbody>
        </table></div>
        <div className="form-actions">
          <Button variant="secondary" disabled={page <= 1 || report.isFetching}
            onClick={() => change("page", String(page - 1))}>السابق</Button>
          <span>صفحة {page}</span>
          <Button variant="secondary" disabled={page * data.pageSize >= data.total || report.isFetching}
            onClick={() => change("page", String(page + 1))}>التالي</Button>
        </div>
      </>}
    </Card>
  </div>;
}
