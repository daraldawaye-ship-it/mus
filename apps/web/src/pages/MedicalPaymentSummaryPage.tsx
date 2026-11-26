import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { formatWholeMoney } from "../format-money";
import { adenInvoiceToday } from "../invoice-save-date";
import { medicalPaymentTimeLabel } from "../medical-payment-time";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader } from "../ui";
import "./MedicalPaymentSummaryPage.css";

const title = "إجمالي سداد الأطباء والممرضين";
const columns = [["name", "الاسم الرئيسي"], ["count", "عدد المرات"], ["total", "الإجمالي"]] as const;
type Sort = typeof columns[number][0];
type Report = { totalAmount?: string; items: Array<{ name: string; movementCount: number; totalAmount: string }> };
type Movement = { date: string; time: string | null; amount: string; actor: string; notes: string | null };
function MovementMoment({ date, time }: Pick<Movement, "date" | "time">) {
  const label = medicalPaymentTimeLabel(time);
  return <span className="medical-payment-moment-content">
    <bdi dir="ltr">{date}</bdi>
    {label && <span className="medical-payment-time-label">
      <bdi dir="ltr">{label.clock}</bdi>{" "}{label.period}
    </span>}
  </span>;
}


export function MedicalPaymentSummaryPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user, employeePreview } = useSession();
  const directory = usePageDirectory(companyId);
  const access = directory.data?.find(entry => entry.key === "company.medical-payment-summary");
  const allowed = !!access?.enabled && !!access.actionAccess.view;
  const now = new Date();
  const today = adenInvoiceToday(now);
  const minDate = adenInvoiceToday(new Date(now.getTime() - 5 * 86_400_000));
  const [dateFrom, setFrom] = useState(() => adenInvoiceToday(new Date(now.getTime() - 86_400_000)));
  const [dateTo, setTo] = useState(today);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [expanded, setExpanded] = useState("");
  const [order, setOrder] = useState<{ sort: Sort; direction: "asc"|"desc" }>({ sort: "total", direction: "desc" });
  const keyword = search.trim();
  useEffect(() => {
    if (keyword === appliedSearch) return;
    const timer = window.setTimeout(() => setAppliedSearch(keyword), 200);
    return () => window.clearTimeout(timer);
  }, [keyword, appliedSearch]);
  const searching = keyword !== appliedSearch;
  const valid = !!dateFrom && !!dateTo && dateFrom >= minDate && dateFrom <= dateTo && dateTo <= today;
  const query = new URLSearchParams({ dateFrom, dateTo, q: appliedSearch, ...order }).toString();
  const report = useQuery({
    queryKey: ["medical-payment-summary", user?.id, companyId, query],
    queryFn: ({ signal }) => api<{ report: Report }>(
      `/companies/${companyId}/medical-payment-summary?${query}`, { signal }),
    enabled: !!user && allowed && valid && !searching,
    refetchOnWindowFocus: "always",
  });
  const detailQuery = new URLSearchParams({dateFrom, dateTo, name: expanded}).toString();
  const detail = useQuery({
    queryKey: ["medical-payment-summary-details", user?.id, companyId, detailQuery],
    queryFn: ({ signal }) => api<{ movements: Movement[] }>(
      `/companies/${companyId}/medical-payment-summary?${detailQuery}`, { signal }),
    enabled: !!user && allowed && valid && !!expanded,
    refetchOnWindowFocus: "always",
  });
  const data = searching ? undefined : report.data?.report;

  return <>
    <PageHeader title={title} />
    {directory.isPending && <Notice>جارٍ التحقق من الصلاحيات…</Notice>}
    {!directory.isPending && !allowed && <Notice tone="warning">لا تملك صلاحية عرض هذا التقرير.</Notice>}
    {allowed && <>
      <Card className="medical-payment-card">
        <div className="form-grid medical-payment-filters">
          <Field label="بحث بالاسم" type="search" value={search} maxLength={200}
            placeholder="اكتب الاسم أو جزءًا منه"
            onChange={event => { setSearch(event.target.value); setExpanded(""); }} />
          <Field label="من تاريخ" type="date" value={dateFrom} min={minDate} max={today}
            onChange={event => { setFrom(event.target.value); setExpanded(""); }} />
          <Field label="إلى تاريخ" type="date" value={dateTo} min={minDate} max={today}
            onChange={event => { setTo(event.target.value); setExpanded(""); }} />
        </div>
        {!valid && <Notice tone="warning">اختر فترة بين {minDate} و{today}، على ألا يتجاوز «من تاريخ» تاريخ النهاية.</Notice>}
      </Card>
      {valid && (report.isPending || searching) && <Notice>جارٍ تحميل الإجماليات…</Notice>}
      {valid && !searching && report.error && <Notice tone="error">{errorMessage(report.error)}</Notice>}
      {valid && data && <Card className="medical-payment-card">
        <div className="table-scroll medical-payment-scroll">
          <table className="medical-payment-summary">
            <colgroup><col className="medical-payment-name-col"/><col className="medical-payment-count-col"/><col/></colgroup>
            <caption>المبالغ بالريال اليمني، بدون القصاصات</caption>
            <thead><tr>{columns.map(([key, label]) =>
              <th key={key} scope="col" aria-sort={order.sort !== key ? "none" : order.direction === "asc" ? "ascending" : "descending"}>
                <Button variant="secondary" size="compact" onClick={() => setOrder(previous => ({
                  sort: key, direction: previous.sort === key ? (previous.direction === "asc" ? "desc" : "asc")
                    : key === "name" ? "asc" : "desc",
                }))}>{label}{order.sort === key ? (order.direction === "asc" ? " ↑" : " ↓") : ""}</Button>
              </th>)}</tr></thead>
            <tbody>{data.items.length ? data.items.map(row => <Fragment key={row.name}>
              <tr>
                <th scope="row"><Button variant="ghost" size="compact" className="medical-payment-name" aria-expanded={expanded === row.name}
                  onClick={() => setExpanded(previous => previous === row.name ? "" : row.name)}>{row.name}</Button></th>
                <td><bdi className="financial-number">{row.movementCount}</bdi></td>
                <td><bdi className="financial-number">{formatWholeMoney(row.totalAmount)}</bdi></td>
              </tr>
              {expanded === row.name && <tr><td className="medical-payment-expanded" colSpan={columns.length}>
                {detail.isPending && <Notice>جارٍ تحميل كشف الحركة…</Notice>}
                {detail.error && <Notice tone="error">{errorMessage(detail.error)}</Notice>}
                {detail.data && (detail.data.movements.length ? <table className="medical-payment-movements" aria-label={`كشف حركة ${row.name}`}>
                  <colgroup><col className="medical-payment-date-col"/><col className="medical-payment-amount-col"/><col className="medical-payment-actor-col"/><col/></colgroup>
                  <thead><tr><th scope="col">التاريخ والوقت</th><th scope="col">المبلغ</th><th scope="col">بواسطة</th><th scope="col">الملاحظات</th></tr></thead>
                  <tbody>{detail.data.movements.map((movement, i) => <tr key={i}>
                    <td><MovementMoment date={movement.date} time={movement.time}/></td>
                    <td><bdi className="financial-number">{formatWholeMoney(movement.amount)}</bdi></td>
                    <td>{movement.actor || "—"}</td>
                    <td className="medical-payment-note-text" dir="auto">{movement.notes?.trim() ? movement.notes : "—"}</td>
                  </tr>)}</tbody>
                </table> : <Notice>لا توجد حركات في الفترة المحددة.</Notice>)}
              </td></tr>}
            </Fragment>) : <tr><td colSpan={columns.length}>لا توجد مبالغ مطابقة.</td></tr>}</tbody>
            {user?.owner && !employeePreview && data.totalAmount !== undefined &&
              <tfoot><tr><th scope="row" colSpan={2}>{appliedSearch ? "إجمالي نتائج البحث" : "إجمالي الفترة"}</th>
                <td><bdi className="financial-number">{formatWholeMoney(data.totalAmount)}</bdi></td></tr></tfoot>}
          </table>
        </div>
      </Card>}
    </>}
  </>;
}
