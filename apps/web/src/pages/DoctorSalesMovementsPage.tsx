import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { formatWholeMoney } from "../format-money";
import { adenInvoiceToday } from "../invoice-save-date";
import { Button, Card, Dialog, Field, Notice, PageHeader, Select } from "../ui";
import "./DoctorSalesMovementsPage.css";

interface MedicalSale {
  id: number;
  number: string;
  documentDate: string;
  createdAt: string;
  total: string;
  currencyCode: string;
  accountName: string;
  doctorName: string;
  doctorKind: "doctor" | "nurse" | null;
  doctorId: number;
  notes: string;
  accounted: boolean;
}
interface Result {
  items: MedicalSale[];
  total: number;
  totals: Array<{
    currencyCode: string; total: string; count: number;
    accountedTotal: string; unaccountedTotal: string;
    accountedCount: number; unaccountedCount: number;
  }>;
  page: number;
  pageSize: number;
}
const adenTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Aden", hour: "2-digit", minute: "2-digit", hour12: false,
});
function invoiceTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : adenTime.format(date);
}

export function DoctorSalesMovementsPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const directory = usePageDirectory(companyId);
  const access = directory.data?.find(entry => entry.key === "company.doctor-sales-movements");
  const canView = !!access?.enabled && !!access.actionAccess.view;
  const canMarkAccounted = !!access?.enabled && !!access.actionAccess.edit;
  const [pendingAccounted, setPendingAccounted] = useState<MedicalSale | null>(null);
  const [accounting, setAccounting] = useState(false);
  const [accountingError, setAccountingError] = useState("");
  const [accountingSuccess, setAccountingSuccess] = useState("");
  const [params, setParams] = useSearchParams();
  const today = adenInvoiceToday();
  const minDate = adenInvoiceToday(new Date(Date.now() - 9 * 86_400_000));
  const defaultFrom = adenInvoiceToday(new Date(Date.now() - 3 * 86_400_000));
  const from = params.get("dateFrom") ?? defaultFrom;
  const to = params.get("dateTo") ?? today;
  const q = params.get("q") ?? "";
  const mainName = params.get("mainName") ?? "";
  const keyword = q.trim();
  const [appliedKeyword, setAppliedKeyword] = useState(keyword);
  useEffect(() => {
    if (keyword === appliedKeyword) return;
    const timer = window.setTimeout(() => setAppliedKeyword(keyword), 250);
    return () => window.clearTimeout(timer);
  }, [keyword, appliedKeyword]);
  const searchPending = keyword !== appliedKeyword;
  const rawPage = Number(params.get("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawSize = Number(params.get("pageSize") ?? "50");
  const pageSize = [20, 50, 100].includes(rawSize) ? rawSize : 50;
  const invalid = !from || !to || from > to || from < minDate ||
    to < minDate || from > today || to > today;
  const filters = new URLSearchParams({
    dateFrom: from, dateTo: to, q: appliedKeyword, mainName,
    page: String(page), pageSize: String(pageSize),
  });
  const results = useQuery({
    queryKey: ["doctor-sales-movements", user?.id, companyId, filters.toString()],
    queryFn: ({ signal }) => api<Result>(
      `/companies/${companyId}/doctor-sales-movements?${filters}`, { signal }),
    enabled: !!user && canView && !invalid && !searchPending,
    staleTime: 0, refetchOnWindowFocus: true,
  });
  const records = searchPending ? undefined : results.data;
  async function markAsAccounted() {
    if (!pendingAccounted || pendingAccounted.doctorKind === null || !canMarkAccounted || accounting) return;
    setAccounting(true);
    setAccountingError("");
    try {
      const response = await api<{ result: { mainName: string; newlyMarked: number } }>(
        `/companies/${companyId}/doctor-sales-movements/${pendingAccounted.id}/accounted`,
        { method: "POST" },
      );
      setPendingAccounted(null);
      setAccountingSuccess(
        `تم تأشير ${response.result.newlyMarked} فاتورة جديدة بـ «محاسب» للـ ${response.result.mainName} حتى التاريخ والوقت المحددين. قد تكون بعض الفواتير خارج فترة العرض؛ استخدم «عرض آخر 10 أيام» لرؤيتها.`
      );
      await results.refetch();
    } catch (error) {
      setAccountingError(errorMessage(error));
    } finally {
      setAccounting(false);
    }
  }
  function change(key: string, value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      if (key !== "page") next.delete("page");
      return next;
    });
  }
  function showLastTenDays() {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set("dateFrom", minDate);
      next.set("dateTo", today);
      next.delete("page");
      return next;
    });
  }
  function changeKeyword(value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.delete("mainName");
      if (value) next.set("q", value); else next.delete("q");
      next.delete("page");
      return next;
    }, { replace: true });
  }
  return (
    <>
      <PageHeader title="حركة مبيعات الأطباء والممرضين" actions={<Button variant="secondary" size="compact" onClick={showLastTenDays}>عرض آخر 10 أيام</Button>} />
      <Card>
        <div className="form-grid">
          <Field label="من تاريخ" type="date" value={from} min={minDate} max={today}
            onChange={event => change("dateFrom", event.target.value)} />
          <Field label="إلى تاريخ" type="date" value={to} min={minDate} max={today}
            onChange={event => change("dateTo", event.target.value)} />
          <Field label="بحث بالاسم" type="search"
            value={q || mainName} autoComplete="off" maxLength={120}
            onChange={event => changeKeyword(event.target.value)}
            placeholder="اكتب الاسم أو جزءًا منه" />
          <Select label="عدد السجلات في الصفحة" value={String(pageSize)}
            onChange={event => change("pageSize", event.target.value)}>
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </Select>
        </div>
        {invalid && <Notice tone="warning">يسمح بعرض آخر 10 أيام فقط (من {minDate} إلى {today})، ويجب ألا يتجاوز تاريخ البداية تاريخ النهاية.</Notice>}
      </Card>
      {directory.isPending && <Notice>جارٍ التحقق من الصلاحيات…</Notice>}
      {!directory.isPending && !canView &&
        <Notice tone="warning">لا تملك صلاحية عرض حركة مبيعات الأطباء والممرضين.</Notice>}
      {!searchPending && results.error && <Notice tone="error">{errorMessage(results.error)}</Notice>}
      {accountingSuccess && <Notice tone="success">{accountingSuccess}</Notice>}
      {canView && !invalid && (
        <Card>
          {(searchPending || results.isPending) && <Notice>جارٍ تحميل الفواتير…</Notice>}
          {records && (
            <>
              <div className="doctor-movements-summary" role="status">
                <strong>{mainName || q ? `${mainName || q} — ` : ""}إجماليات صافي الفواتير:</strong>
                {records.totals.length ? records.totals.map(total => (
                  <span key={total.currencyCode}>
                    <strong>المحاسب: </strong>
                    <bdi className="financial-number">{formatWholeMoney(total.accountedTotal)}</bdi>
                    {" ("}{total.accountedCount}{" فاتورة) — "}
                    <strong>غير المحاسب: </strong>
                    <bdi className="financial-number">{formatWholeMoney(total.unaccountedTotal)}</bdi>
                    {" ("}{total.unaccountedCount}{" فاتورة)"}
                    {records.totals.length > 1 ? ` (${total.currencyCode})` : ""}
                  </span>
                )) : <span>المحاسب: 0 — غير المحاسب: 0</span>}
                <span>إجمالي الفواتير: {records.total}</span>
              </div>
              <div className="table-scroll doctor-movements-desktop-table">
                <table>
                  <thead>
                    <tr>
                      <th>فتح</th>
                      <th>الصافي</th>
                      <th>التاريخ والوقت</th>
                      <th>الاسم الرئيسي</th>
                      <th>الحالة والتأشير</th>
                      <th>الحساب</th>
                      <th>الملاحظات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.items.map(row => (
                      <tr key={row.id}>
                        <td><Link to={`/companies/${companyId}/invoices/${row.id}`}>فتح</Link></td>
                        <td><bdi className="financial-number">{formatWholeMoney(row.total)}</bdi></td>
                        <td><span dir="ltr">{row.documentDate} {invoiceTime(row.createdAt)}</span></td>
                        <td><Link to={`/companies/${companyId}/doctors?focus=${row.doctorId}`}>
                          {row.doctorName}
                        </Link>{row.doctorKind === null && <small className="muted"> (غير معين)</small>}</td>
                        <td className="doctor-movements-accounting-column">
                          {row.accounted ? (
                            <strong className="doctor-movements-accounted">محاسب</strong>
                          ) : (
                            <div className="doctor-movements-accounting-cell">
                              <span className="muted">غير محاسب</span>
                              {canMarkAccounted && row.doctorKind !== null && (
                                <Button variant="secondary" size="compact"
                                  onClick={() => {
                                    setPendingAccounted(row);
                                    setAccountingError("");
                                    setAccountingSuccess("");
                                  }}>محاسب حتى هنا</Button>
                              )}
                            </div>
                          )}
                        </td>
                        <td>{row.accountName || "—"}</td>
                        <td>{row.notes || "—"}</td>
                      </tr>
                    ))}
                    {!records.items.length && <tr><td colSpan={7}>لا توجد فواتير مطابقة للفترة والبحث.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="doctor-movements-mobile-list" role="list" aria-label="فواتير حركة الأطباء والممرضين">
                {records.items.map(row => (
                  <div className="doctor-movements-mobile-entry" role="listitem" key={row.id}>
                    <div className="doctor-movements-mobile-line doctor-movements-mobile-main">
                      <Link className="doctor-movements-mobile-name"
                        to={`/companies/${companyId}/doctors?focus=${row.doctorId}`}>
                        {row.doctorName}{row.doctorKind === null && <small className="muted"> (غير معين)</small>}
                      </Link>
                      <bdi className="financial-number doctor-movements-mobile-total">
                        {formatWholeMoney(row.total)}
                      </bdi>
                      {row.accounted ? (
                        <strong className="doctor-movements-mobile-status">محاسب</strong>
                      ) : canMarkAccounted && row.doctorKind !== null ? (
                        <button type="button" className="doctor-movements-mobile-mark"
                          aria-label={`غير محاسب؛ تأشير الفاتورة ${row.number} وجميع الأقدم منها`}
                          onClick={() => {
                            setPendingAccounted(row);
                            setAccountingError("");
                            setAccountingSuccess("");
                          }}>محاسب حتى هنا</button>
                      ) : <span className="doctor-movements-mobile-status">غير محاسب</span>}
                      <Link className="doctor-movements-mobile-open"
                        to={`/companies/${companyId}/invoices/${row.id}`}>فتح</Link>
                    </div>
                    <div className="doctor-movements-mobile-line doctor-movements-mobile-details">
                      <span className="doctor-movements-mobile-date" dir="ltr">
                        {row.documentDate} {invoiceTime(row.createdAt)}
                      </span>
                      <span className="doctor-movements-mobile-account">حساب: {row.accountName || "—"}</span>
                      <span className="doctor-movements-mobile-notes">ملاحظات: {row.notes || "—"}</span>
                    </div>
                  </div>
                ))}
                {!records.items.length && <p className="doctor-movements-mobile-empty">
                  لا توجد فواتير مطابقة للفترة والبحث.
                </p>}
              </div>
              <div className="form-actions">
                <Button variant="secondary" size="compact"
                  disabled={page <= 1 || results.isFetching}
                  onClick={() => change("page", String(page - 1))}>السابق</Button>
                <span>صفحة {page} من {Math.max(1, Math.ceil(records.total / pageSize))} — {records.total} فاتورة</span>
                <Button variant="secondary" size="compact"
                  disabled={page * pageSize >= records.total || results.isFetching}
                  onClick={() => change("page", String(page + 1))}>التالي</Button>
              </div>
            </>
          )}
        </Card>
      )}
      <Dialog
        open={pendingAccounted !== null}
        title="تأكيد التأشير كمحاسب"
        onClose={() => { if (!accounting) setPendingAccounted(null); }}
        footer={<div className="form-actions">
          <Button variant="secondary" disabled={accounting}
            onClick={() => setPendingAccounted(null)}>إلغاء</Button>
          <Button disabled={accounting} onClick={() => void markAsAccounted()}>
            {accounting ? "جارٍ التأشير…" : "تأكيد التأشير"}
          </Button>
        </div>}
      >
        {pendingAccounted && (
          <div className="form-stack">
            <p>هل تريد تأشير هذه الفاتورة وجميع الفواتير الأقدم منها للطبيب أو الممرض الرئيسي
              <strong> «{pendingAccounted.doctorName}» </strong>
              وكروته الفرعية بعبارة «محاسب»؟</p>
            <p>حتى الفاتورة بتاريخ <bdi dir="ltr">{pendingAccounted.documentDate} {invoiceTime(pendingAccounted.createdAt)}</bdi>
              ، ويشمل هذا التأشير الفواتير السابقة خارج فترة العرض، ولا يشمل الفواتير الأحدث منها.</p>
            <small className="muted">يُسجل اسم منفّذ التأشير وتوقيته، ولا ينتج عنه قيد مالي أو تعديل مخزون.</small>
            {accountingError && <Notice tone="error">{accountingError}</Notice>}
          </div>
        )}
      </Dialog>
    </>
  );
}
