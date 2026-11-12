import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";
import { errorMessage } from "../phase2";

type PurchaseLine = {
  id: number;
  invoiceId: number;
  invoiceNumber: string;
  createdAt: string;
  documentDate: string;
  itemName: string;
  quantity: string;
  price: string;
  lineTotal: string;
  invoiceNet: string;
  supplier: string;
};
type Result = { items: PurchaseLine[]; total: number; page: number; pageSize: number };

export function PurchaseLineMovementsPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [search, setSearch] = useState("");
  const [queryText, setQueryText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const movements = useQuery({
    queryKey: ["purchase-line-movements", user?.id, companyId, queryText, from, to, page],
    queryFn: ({ signal }) => {
      const p = new URLSearchParams({ page: String(page) });
      if (queryText) p.set("q", queryText);
      if (from) p.set("dateFrom", from);
      if (to) p.set("dateTo", to);
      return api<Result>(`/companies/${companyId}/purchases/line-movements?${p.toString()}`, { signal });
    },
    enabled: !!user && (!from || !to || from <= to),
    staleTime: 15_000,
  });
  const money = (v: string) => {
    const num = Number(v);
    return Number.isFinite(num) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(num) : v;
  };
  const dateTime = (value: string) => {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString("ar-YE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const totalPages = Math.max(1, Math.ceil((movements.data?.total ?? 0) / 50));
  return (
    <section>
      <PageHeader title="متابعة حركة أصناف المشتريات" />
      <Card>
        <form onSubmit={event => { event.preventDefault(); setPage(1); setQueryText(search.trim()); }}
          style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "end", marginBottom: 8 }}>
          <label style={{ flex: "2 1 190px" }}>بحث بالصنف أو المورد
            <input type="search" value={search} maxLength={120} onChange={e => setSearch(e.target.value)} placeholder="الصنف / المورد" />
          </label>
          <label style={{ flex: "1 1 125px" }}>من
            <input type="date" value={from} onChange={e => { setPage(1); setFrom(e.target.value); }} />
          </label>
          <label style={{ flex: "1 1 125px" }}>إلى
            <input type="date" value={to} onChange={e => { setPage(1); setTo(e.target.value); }} />
          </label>
          <Button type="submit" size="compact">بحث</Button>
          <Button type="button" variant="secondary" size="compact" onClick={() => window.print()}>طباعة</Button>
        </form>
        {from && to && from > to && <Notice tone="warning">تاريخ البداية بعد النهاية.</Notice>}
        {movements.isError && <Notice tone="error">{errorMessage(movements.error)}</Notice>}
        {movements.isLoading && <Notice>جارٍ تحميل الحركة…</Notice>}
        {movements.data && <>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" dir="rtl" style={{ width: "100%", whiteSpace: "nowrap" }}>
              <thead><tr>
                <th>الصنف</th><th>الكمية</th><th>السعر</th><th>إجمالي السعر</th>
                <th>صافي الفاتورة</th><th>المورد</th><th>التاريخ والوقت</th>
              </tr></thead>
              <tbody>
                {movements.data.items.map(item => <tr key={item.id}>
                  <td><Link to={`/companies/${companyId}/invoices/${item.invoiceId}`}>{item.itemName}</Link></td>
                  <td dir="ltr">{item.quantity}</td>
                  <td dir="ltr">{money(item.price)}</td>
                  <td dir="ltr">{money(item.lineTotal)}</td>
                  <td dir="ltr">{money(item.invoiceNet)}</td>
                  <td>{item.supplier || "—"}</td>
                  <td title={item.documentDate}>{dateTime(item.createdAt)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {movements.data.items.length === 0 && <Notice>لا توجد أصناف مطابقة.</Notice>}
          <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
            <small>عدد السطور: {movements.data.total} — الصفحة {page} من {totalPages}</small>
            <div style={{ display: "flex", gap: 6 }}>
              <Button type="button" size="compact" variant="secondary" disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}>السابق</Button>
              <Button type="button" size="compact" variant="secondary" disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}>التالي</Button>
            </div>
          </div>
        </>}
      </Card>
    </section>
  );
}
