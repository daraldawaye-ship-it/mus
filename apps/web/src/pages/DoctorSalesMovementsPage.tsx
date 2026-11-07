import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { formatWholeMoney } from "../format-money";
import { adenInvoiceToday } from "../invoice-save-date";
import { Button, Card, Dialog, Field, Notice, PageHeader, Select } from "../ui";

interface MedicalSale {
  id: number;
  number: string;
  documentDate: string;
  createdAt: string;
  total: string;
  currencyCode: string;
  accountName: string;
  doctorName: string;
  doctorKind: "doctor" | "nurse";
  doctorId: number;
  notes: string;
  accounted: boolean;
}
interface Result {
  items: MedicalSale[];
  total: number;
  totals: Array<{ currencyCode: string; total: string; count: number }>;
  page: number;
  pageSize: number;
}
interface MainName {
  name: string;
  kinds: Array<"doctor" | "nurse">;
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
  const minDate = adenInvoiceToday(new Date(Date.now() - 10 * 86_400_000));
  const from = params.get("dateFrom") ?? minDate;
  const to = params.get("dateTo") ?? today;
  const q = params.get("q") ?? "";
  const mainName = params.get("mainName") ?? "";
  const [search, setSearch] = useState(mainName || q);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const rawPage = Number(params.get("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawSize = Number(params.get("pageSize") ?? "50");
  const pageSize = [20, 50, 100].includes(rawSize) ? rawSize : 50;
  const invalid = !from || !to || from > to || from < minDate ||
    to < minDate || from > today || to > today;
  const filters = new URLSearchParams({
    dateFrom: from, dateTo: to, q, mainName,
    page: String(page), pageSize: String(pageSize),
  });
  const choices = useQuery({
    queryKey: ["doctor-main-names", user?.id, companyId, search.trim()],
    queryFn: ({ signal }) => api<{ items: MainName[] }>(
      `/companies/${companyId}/doctor-sales-movements/main-names?q=${encodeURIComponent(search.trim())}`,
      { signal }),
    enabled: !!user && canView && suggestionsOpen,
    staleTime: 30_000,
  });
  const results = useQuery({
    queryKey: ["doctor-sales-movements", user?.id, companyId, filters.toString()],
    queryFn: ({ signal }) => api<Result>(
      `/companies/${companyId}/doctor-sales-movements?${filters}`, { signal }),
    enabled: !!user && canView && !invalid,
    staleTime: 0, refetchOnWindowFocus: true,
  });
  const records = results.data;
  async function markAsAccounted() {
    if (!pendingAccounted || !canMarkAccounted || accounting) return;
    setAccounting(true);
    setAccountingError("");
    try {
      const response = await api<{ result: { mainName: string; newlyMarked: number } }>(
        `/companies/${companyId}/doctor-sales-movements/${pendingAccounted.id}/accounted`,
        { method: "POST" },
      );
      setPendingAccounted(null);
      setAccountingSuccess(
        `تم تأشير ${response.result.newlyMarked} فاتورة جديدة بـ «محاسب» للـ ${response.result.mainName} حتى التاريخ والوقت المحددين.`
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
  function searchMainName(event: FormEvent) {
    event.preventDefault();
    setSuggestionsOpen(false);
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.delete("mainName");
      if (search.trim()) next.set("q", search.trim()); else next.delete("q");
      next.delete("page");
      return next;
    });
  }
  function selectMainName(name: string) {
    setSearch(name);
    setSuggestionsOpen(false);
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set("mainName", name);
      next.delete("q");
      next.delete("page");
      return next;
    });
  }
  return (
    <>
      <PageHeader title="حركة مبيعات الأطباء والممرضين" />
      <Card>
        <div className="form-grid">
          <Field label="من تاريخ" type="date" value={from} min={minDate} max={today}
            onChange={event => change("dateFrom", event.target.value)} />
          <Field label="إلى تاريخ" type="date" value={to} min={minDate} max={today}
            onChange={event => change("dateTo", event.target.value)} />
          <form className="form-actions" onSubmit={searchMainName}
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setSuggestionsOpen(false);
            }}>
            <div className="doctor-movements-suggest">
              <Field label="بحث باسم الطبيب أو الجهة الرئيسي" type="search"
                value={search} autoComplete="off"
                onFocus={() => setSuggestionsOpen(true)}
                onChange={event => {
                  setSearch(event.target.value);
                  setSuggestionsOpen(true);
                }}
                placeholder="اختر الاسم الرئيسي من النتائج"
                aria-expanded={suggestionsOpen} aria-controls="doctor-main-name-choices"
              />
              {suggestionsOpen && (
                <div className="invoice-doctor-options" id="doctor-main-name-choices" role="listbox">
                  {choices.isFetching && <small>جارٍ البحث عن الأسماء الرئيسية…</small>}
                  {choices.isError && <small>تعذر تحميل الأسماء؛ يمكنك البحث بالنص.</small>}
                  {choices.data?.items.map(choice => (
                    <button type="button" key={choice.name}
                      role="option" aria-selected={mainName === choice.name}
                      onClick={() => selectMainName(choice.name)}>
                      <span>{choice.name}</span>
                      <small>{choice.kinds.includes("doctor") && choice.kinds.includes("nurse")
                        ? "طبيب / ممرض" : choice.kinds.includes("doctor") ? "طبيب" : "ممرض"}</small>
                    </button>
                  ))}
                  {choices.data?.items.length === 0 && <small>لا توجد أسماء رئيسية مطابقة.</small>}
                </div>
              )}
            </div>
            <Button type="submit">بحث</Button>
          </form>
          <Select label="عدد السجلات في الصفحة" value={String(pageSize)}
            onChange={event => change("pageSize", event.target.value)}>
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </Select>
        </div>
        {invalid && <Notice tone="warning">يمكن اختيار التواريخ من {minDate} إلى {today} فقط، ويجب ألا يتجاوز تاريخ البداية تاريخ النهاية.</Notice>}
      </Card>
      {directory.isPending && <Notice>جارٍ التحقق من الصلاحيات…</Notice>}
      {!directory.isPending && !canView &&
        <Notice tone="warning">لا تملك صلاحية عرض حركة مبيعات الأطباء والممرضين.</Notice>}
      {results.error && <Notice tone="error">{errorMessage(results.error)}</Notice>}
      {accountingSuccess && <Notice tone="success">{accountingSuccess}</Notice>}
      {canView && !invalid && (
        <Card>
          {results.isPending && <Notice>جارٍ تحميل الفواتير…</Notice>}
          {records && (
            <>
              {(mainName || q) && (
                <div className="doctor-movements-summary" role="status">
                  <strong>{mainName || q} — إجمالي صافي الفواتير المطابقة:</strong>
                  {records.totals.length ? records.totals.map(total => (
                    <span key={total.currencyCode}>
                      <bdi className="financial-number">{formatWholeMoney(total.total)}</bdi>
                      {records.totals.length > 1 ? ` (${total.currencyCode})` : ""}
                    </span>
                  )) : <span>0</span>}
                  <span>عدد الفواتير: {records.total}</span>
                </div>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>فتح</th>
                      <th>الصافي</th>
                      <th>الحساب</th>
                      <th>التاريخ والوقت</th>
                      <th>الطبيب أو الجهة (الرئيسي)</th>
                      <th>الملاحظات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.items.map(row => (
                      <tr key={row.id}>
                        <td><Link to={`/companies/${companyId}/invoices/${row.id}`}>فتح</Link></td>
                        <td><bdi className="financial-number">{formatWholeMoney(row.total)}</bdi></td>
                        <td>{row.accountName || "—"}</td>
                        <td>
                          {canMarkAccounted ? (
                            <button type="button" className="doctor-movements-account-link"
                              title={`تأشير جميع فواتير ${row.doctorName} حتى هذه الفاتورة بأنها محاسب`}
                              onClick={() => {
                                setPendingAccounted(row);
                                setAccountingError("");
                                setAccountingSuccess("");
                              }}>
                              <span dir="ltr">{row.documentDate} {invoiceTime(row.createdAt)}</span>
                            </button>
                          ) : <span dir="ltr">{row.documentDate} {invoiceTime(row.createdAt)}</span>}
                          {row.accounted && <strong className="doctor-movements-accounted">محاسب</strong>}
                        </td>
                        <td><Link to={`/companies/${companyId}/doctors?focus=${row.doctorId}`}>
                          {row.doctorName}
                        </Link></td>
                        <td>{row.notes || "—"}</td>
                      </tr>
                    ))}
                    {!records.items.length && <tr><td colSpan={6}>لا توجد فواتير مطابقة للفترة والبحث.</td></tr>}
                  </tbody>
                </table>
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
              ، ويشمل هذا التأشير الفواتير السابقة خارج فترة العرض.</p>
            <small className="muted">يُسجل اسم منفّذ التأشير وتوقيته، ولا ينتج عنه قيد مالي أو تعديل مخزون.</small>
            {accountingError && <Notice tone="error">{accountingError}</Notice>}
          </div>
        )}
      </Dialog>
    </>
  );
}
