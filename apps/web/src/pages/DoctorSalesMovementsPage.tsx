import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { formatMoney } from "../format-money";
import { adenInvoiceToday } from "../invoice-save-date";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

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
}
interface Result {
  items: MedicalSale[];
  total: number;
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
  const [params, setParams] = useSearchParams();
  const today = adenInvoiceToday();
  const from = params.get("dateFrom") ?? today;
  const to = params.get("dateTo") ?? today;
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const rawPage = Number(params.get("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawSize = Number(params.get("pageSize") ?? "50");
  const pageSize = [20, 50, 100].includes(rawSize) ? rawSize : 50;
  const invalid = !from || !to || from > to;
  const filters = new URLSearchParams({
    dateFrom: from, dateTo: to, q,
    page: String(page), pageSize: String(pageSize),
  });
  const results = useQuery({
    queryKey: ["doctor-sales-movements", user?.id, companyId, filters.toString()],
    queryFn: ({ signal }) => api<Result>(
      `/companies/${companyId}/doctor-sales-movements?${filters}`, { signal }),
    enabled: !!user && canView && !invalid,
    staleTime: 0, refetchOnWindowFocus: true,
  });
  const records = results.data;
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
    change("q", search.trim());
  }
  return (
    <>
      <PageHeader title="حركة مبيعات الأطباء والممرضين"
        description="فواتير البيع المرتبطة بطبيب أو ممرض فقط. الاسم المعروض والبحث بحسب الاسم الرئيسي، ويشمل الكروت الفرعية."
        actions={<Button variant="secondary" disabled={!canView || results.isFetching}
          onClick={() => void results.refetch()}>تحديث</Button>}
      />
      <Card title="البحث والفترة">
        <div className="form-grid">
          <Field label="من تاريخ" type="date" value={from}
            onChange={event => change("dateFrom", event.target.value)} />
          <Field label="إلى تاريخ" type="date" value={to}
            onChange={event => change("dateTo", event.target.value)} />
          <form className="form-actions" onSubmit={searchMainName}>
            <Field label="البحث باسم الطبيب أو الجهة الرئيسي" type="search"
              value={search} onChange={event => setSearch(event.target.value)}
              placeholder="يشمل جميع الكروت الفرعية" />
            <Button type="submit">بحث</Button>
          </form>
          <Select label="عدد السجلات في الصفحة" value={String(pageSize)}
            onChange={event => change("pageSize", event.target.value)}>
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </Select>
        </div>
        <div className="form-actions">
          <Button size="compact" variant="secondary"
            onClick={() => {
              setParams(previous => {
                const next = new URLSearchParams(previous);
                next.set("dateFrom", today);
                next.set("dateTo", today);
                next.delete("page");
                return next;
              });
            }}>فواتير اليوم</Button>
        </div>
        {invalid && <Notice tone="warning">تاريخ البداية يجب ألا يتجاوز تاريخ النهاية.</Notice>}
      </Card>
      {directory.isPending && <Notice>جارٍ التحقق من الصلاحيات…</Notice>}
      {!directory.isPending && !canView &&
        <Notice tone="warning">لا تملك صلاحية عرض حركة مبيعات الأطباء والممرضين.</Notice>}
      {results.error && <Notice tone="error">{errorMessage(results.error)}</Notice>}
      {canView && !invalid && (
        <Card title={`الفواتير المطابقة: ${records?.total ?? "…"}`}>
          {results.isPending && <Notice>جارٍ تحميل الفواتير…</Notice>}
          {records && (
            <>
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
                        <td><bdi className="financial-number">{formatMoney(row.total)}</bdi></td>
                        <td>{row.accountName || "—"}</td>
                        <td>
                          <span dir="ltr">{row.documentDate} {invoiceTime(row.createdAt)}</span>
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
    </>
  );
}
