import { useState } from "react";
import "./PurchaseLineMovementsPage.css";
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

function localToday() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
type SortKey = "itemName" | "quantity" | "price" | "lineTotal" | "invoiceNet" | "supplier" | "createdAt";

export function PurchaseLineMovementsPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [search, setSearch] = useState("");
  const [queryText, setQueryText] = useState("");
  const [from, setFrom] = useState(localToday);
  const [to, setTo] = useState(localToday);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "createdAt", desc: true });
  const [page, setPage] = useState(1);
  const movements = useQuery({
    queryKey: ["purchase-line-movements", user?.id, companyId, queryText, from, to, page, sort],
    queryFn: ({ signal }) => {
      const p = new URLSearchParams({ page: String(page), sortKey: sort.key, sortDirection: sort.desc ? "desc" : "asc" });
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
  const sortHeader = (label: string, key: SortKey) => (
    <button type="button" className="purchase-movement-sort"
      onClick={() => { setPage(1); setSort(current => ({ key, desc: current.key === key ? !current.desc : key === "createdAt" })); }}>
      {label}{sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
    </button>
  );
  const totalPages = Math.max(1, Math.ceil((movements.data?.total ?? 0) / 50));
  return (
    <section className="purchase-movement-page">
      <PageHeader title="متابعة حركة أصناف المشتريات" />
      <Card>
        <form onSubmit={event => { event.preventDefault(); setPage(1); setQueryText(search.trim()); }}
          className="purchase-movement-filters">
          <label className="purchase-movement-filter-search">بحث بالصنف أو المورد
            <input type="search" value={search} maxLength={120} onChange={e => setSearch(e.target.value)} placeholder="الصنف / المورد" />
          </label>
          <label className="purchase-movement-filter-date">من
            <input type="date" value={from} onChange={e => { setPage(1); setFrom(e.target.value); }} />
          </label>
          <label className="purchase-movement-filter-date">إلى
            <input type="date" value={to} onChange={e => { setPage(1); setTo(e.target.value); }} />
          </label>
          <Button type="submit" size="compact">بحث</Button>
          <Button type="button" variant="ghost" size="compact" onClick={() => { const today = localToday(); setFrom(today); setTo(today); setPage(1); }}>اليوم</Button>
          <Button type="button" variant="secondary" size="compact" onClick={() => window.print()}>طباعة</Button>
        </form>
        {from && to && from > to && <Notice tone="warning">تاريخ البداية بعد النهاية.</Notice>}
        {movements.isError && <Notice tone="error">{errorMessage(movements.error)}</Notice>}
        {movements.isLoading && <Notice>جارٍ تحميل الحركة…</Notice>}
        {movements.data && <>
          <div className="purchase-movement-table-wrap" role="region" tabIndex={0} aria-label="جدول حركة أصناف المشتريات">
            <table className="data-table purchase-movement-table" dir="rtl">
              <thead><tr>
                <th>{sortHeader("الصنف", "itemName")}</th><th>{sortHeader("الكمية", "quantity")}</th><th>{sortHeader("السعر", "price")}</th><th>{sortHeader("إجمالي السعر", "lineTotal")}</th>
                <th>{sortHeader("صافي الفاتورة", "invoiceNet")}</th><th>{sortHeader("المورد", "supplier")}</th><th>{sortHeader("التاريخ والوقت", "createdAt")}</th>
              </tr></thead>
              <tbody>
                {movements.data.items.map(item => <tr key={item.id}>
                  <td><Link to={`/companies/${companyId}/invoices/${item.invoiceId}`}>{item.itemName}</Link></td>
                  <td className="purchase-movement-number" dir="ltr">{item.quantity}</td>
                  <td className="purchase-movement-number" dir="ltr">{money(item.price)}</td>
                  <td className="purchase-movement-number" dir="ltr">{money(item.lineTotal)}</td>
                  <td className="purchase-movement-number" dir="ltr">{money(item.invoiceNet)}</td>
                  <td>{item.supplier || "—"}</td>
                  <td className="purchase-movement-date" title={"تاريخ الفاتورة: " + item.documentDate}>{dateTime(item.createdAt)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {movements.data.items.length === 0 && <Notice>لا توجد أصناف مطابقة.</Notice>}
          <div className="purchase-movement-pagination">
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
