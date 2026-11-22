import { useState } from "react";
import "./PurchaseLineMovementsPage.css";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";
import { isDockEntityId } from "../dock-card-access";
import { errorMessage } from "../phase2";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";

type PurchaseLine = {
  id: number;
  invoiceId: number;
  invoiceNumber: string;
  createdAt: string;
  documentDate: string;
  itemId: number | null;
  itemName: string;
  quantity: string;
  bonusQuantity: string;
  netQuantity: string;
  price: string;
  netPrice: string | null;
  lineTotal: string;
  invoiceNet: string;
  supplier: string;
};
type Result = { items: PurchaseLine[]; total: number; page: number; pageSize: number };

function localToday() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
type SortKey = "itemName" | "quantity" | "price" | "netQuantity" | "netPrice" | "lineTotal" | "invoiceNet" | "supplier" | "createdAt";

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
  type ColumnKey = SortKey | "bonusQuantity" | "invoice";
  const number = (value: string) => <bdi className="purchase-movement-number">{value}</bdi>;
  const columns: InteractiveTableColumn<PurchaseLine, ColumnKey>[] = [
    { key: "itemName", label: "الصنف", width: 230, scrollText: true,
      cell: row => <span className="company-item-label" title={row.itemName}>{row.itemName}</span> },
    { key: "quantity", label: "الكمية", width: 90, cell: row => number(row.quantity) },
    { key: "price", label: "السعر", width: 90, cell: row => number(money(row.price)) },
    { key: "lineTotal", label: "إجمالي السعر", width: 115, cell: row => number(money(row.lineTotal)) },
    { key: "bonusQuantity", label: "البونص", width: 85, sortable: false, cell: row => number(row.bonusQuantity) },
    { key: "netQuantity", label: "صافي الكمية", width: 110, cell: row => number(money(row.netQuantity)) },
    { key: "netPrice", label: "سعر الشراء الصافي", width: 145,
      cell: row => row.netPrice === null ? "—" : number(money(row.netPrice)) },
    { key: "invoiceNet", label: "صافي الفاتورة", width: 125, cell: row => number(money(row.invoiceNet)) },
    { key: "supplier", label: "المورد", width: 150, scrollText: true, cell: row => row.supplier || "—" },
    { key: "createdAt", label: "التاريخ والوقت", width: 150,
      cell: row => <span className="purchase-movement-date" title={`تاريخ الفاتورة: ${row.documentDate}`}>{dateTime(row.createdAt)}</span> },
    { key: "invoice", label: "الفاتورة", width: 105, sortable: false,
      cell: row => <Link to={`/companies/${companyId}/invoices/${row.invoiceId}`}>{row.invoiceNumber || "فتح الفاتورة"}</Link> },
  ];
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
          <InteractiveColumnsTable<PurchaseLine, ColumnKey>
            className="purchase-movement-d13" columns={columns} rows={movements.data.items} rowKey={row => row.id}
            visibleColumns={columns.map(column => column.key)} allowColumnVisibility
            storageKey={`alraesy:d13:purchase-line-movements:${companyId}:${user?.id ?? "guest"}`}
            sortKey={sort.key} sortDirection={sort.desc ? "desc" : "asc"}
            onSort={key => {
              if (key === "bonusQuantity" || key === "invoice") return;
              setPage(1);
              setSort(current => ({ key, desc: current.key === key ? !current.desc : key === "createdAt" }));
            }}
            dockRowSource={row => isDockEntityId(row.itemId)
              ? { companyId, itemId: row.itemId, itemName: row.itemName } : undefined}
            ariaLabel="جدول حركة أصناف المشتريات" emptyMessage="لا توجد أصناف مطابقة."
          />
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
