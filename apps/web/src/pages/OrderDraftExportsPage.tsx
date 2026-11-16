import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";
import { errorMessage } from "../phase2";

type ExportRow = {
  id: number; itemId: number; itemName: string;
  requiredQuantity: string | null; availableQuantity: string;
  exportDate: string; exportedAt: string;
};
type ExportResult = { items: ExportRow[]; total: number; page: number; pageSize: number };

export function OrderDraftExportsPage({ context }: { context: CompanyContext }) {
  const [params] = useSearchParams();
  return params.get("view") === "purchases"
    ? <PurchaseComparison context={context} />
    : <ExportHistory context={context} />;
}

const comparisonColumns = {
  itemName: "اسم الصنف",
  requested: "الكمية المطلوبة أمس",
  purchased: "إجمالي الكمية المشتراة أمس واليوم",
} as const;
type ComparisonColumn = keyof typeof comparisonColumns;

function compareQuantity(left: string, right: string) {
  const [a, fractionA = ""] = left.split(".");
  const [b, fractionB = ""] = right.split(".");
  return a.length - b.length || a.localeCompare(b, "en") || fractionA.localeCompare(fractionB, "en");
}

function PurchaseComparison({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ column: ComparisonColumn; descending: boolean } | null>(null);
  const base = `/companies/${companyId}/order-draft-exports`;
  type Row = { itemId: number; itemName: string; requested: string | null; purchased: string };
  const result = useQuery({
    queryKey: ["order-purchase-comparison", companyId, user?.id],
    queryFn: ({ signal }) => api<{ items: Row[] }>(base + "/purchase-comparison", { signal }),
    enabled: !!user,
  });
  const rows = useMemo(() => {
    const filtered = result.data?.items.filter(row => row.itemName.includes(search.trim()));
    if (!sort) return filtered;
    return filtered?.sort((a, b) => {
      const left = a[sort.column], right = b[sort.column];
      if (left === null || right === null) return Number(left === null) - Number(right === null);
      const order = sort.column === "itemName"
        ? left.localeCompare(right, "ar", { numeric: true })
        : compareQuantity(left, right);
      return (sort.descending ? -order : order) || a.itemId - b.itemId;
    });
  }, [result.data, search, sort]);
  const heading = (column: ComparisonColumn) => {
    const active = sort?.column === column;
    return <th scope="col" aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}>
      <button type="button" style={{ width: "100%", border: 0, background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" }}
        onClick={() => setSort(current => ({ column, descending: current?.column === column && !current.descending }))}>
        {comparisonColumns[column]} <span aria-hidden="true">{active ? (sort.descending ? "▼" : "▲") : "↕"}</span>
      </button>
    </th>;
  };
  return <section>
    <PageHeader title="فارق الشراء والطلبيه"
      description="بحسب تاريخ الترحيل وتاريخ فاتورة الشراء بتوقيت عدن. الكميات بالوحدة الأولى للصنف."
      actions={<Link className="button button-secondary" to={base}>الطلبيات المرحلة</Link>} />
    <Card>
      <label>بحث عن الصنف<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <Button variant="secondary" size="compact" onClick={() => void result.refetch()}>تحديث</Button>
      {result.isPending && <Notice>جارٍ تحميل الأصناف…</Notice>}
      {result.isError && <Notice tone="error">{errorMessage(result.error)}</Notice>}
      {rows && <>
        <small>عدد الأصناف: {rows.length}</small>
        <table className="data-table" dir="rtl">
          <thead><tr>{heading("itemName")}{heading("requested")}{heading("purchased")}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.itemId}>
            <td><Link to={`/companies/${companyId}/items/${row.itemId}`}>{row.itemName}</Link></td>
            <td>{row.requested ?? "—"}</td><td>{row.purchased}</td>
          </tr>)}</tbody>
        </table>
        {!rows.length && <Notice>لا توجد أصناف مطابقة.</Notice>}
      </>}
    </Card>
  </section>;
}

function ExportHistory({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<"name" | "required" | "available" | "date">("date");
  const [descending, setDescending] = useState(true);
  const result = useQuery({
    queryKey: ["order-draft-exports", companyId, user?.id, filter, page],
    queryFn: ({ signal }) => api<ExportResult>(
      "/companies/" + companyId + "/order-draft-exports?" +
      new URLSearchParams({ q: filter, page: String(page) }), { signal }),
    enabled: !!user, staleTime: 10_000,
  });
  const totalPages = Math.max(1, Math.ceil((result.data?.total ?? 0)/100));
  const dateText = (value: string) => value.slice(0, 10);
  const quantityText = (value: string | null, integer = false) => {
    if (value == null || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return value;
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: integer ? 0 : 4 }).format(number);
  };
  const sortedItems = useMemo(() => [...(result.data?.items ?? [])].sort((a, b) => {
    const compared = sort === "name"
      ? a.itemName.localeCompare(b.itemName, "ar")
      : sort === "required" ? Number(a.requiredQuantity ?? 0) - Number(b.requiredQuantity ?? 0)
      : sort === "available" ? Number(a.availableQuantity) - Number(b.availableQuantity)
      : a.exportDate.localeCompare(b.exportDate) || a.exportedAt.localeCompare(b.exportedAt);
    return descending ? -compared : compared;
  }), [result.data?.items, sort, descending]);
  const changeSort = (column: typeof sort) => {
    if (sort === column) setDescending(value => !value);
    else { setSort(column); setDescending(column === "date"); }
  };
  const heading = (column: typeof sort, label: string) =>
    <button type="button" onClick={() => changeSort(column)}
      aria-label={`ترتيب حسب ${label}`} aria-sort={sort === column ? (descending ? "descending" : "ascending") : undefined}
      style={{ border:0, background:"transparent", color:"inherit", font:"inherit", fontWeight:"inherit", cursor:"pointer", padding:0 }}>
      {label}{sort === column ? (descending ? " ▼" : " ▲") : ""}
    </button>;
  return <section className="order-export-followup">
    <PageHeader title="متابعة الطلبيات المرحلة"
      description="سجل مشترك لجميع أجهزة الشركة؛ الصنف لا يُسجل أكثر من مرة في اليوم، والسجلات الأقدم من 40 يومًا تُحذف تلقائيًا."
      actions={<><Link className="button button-secondary" to="?view=purchases">فارق الشراء والطلبيه</Link> <Link className="button button-secondary" to={`/companies/${companyId}/item-order-drafts`}>متابعة المسودة</Link></>} />
    <Card>
      <form onSubmit={event => { event.preventDefault(); setFilter(search.trim()); setPage(1); }}
        style={{ display:"flex", flexWrap:"wrap", alignItems:"end", gap:6, marginBottom:8 }}>
        <label style={{ flex:"1 1 180px" }}>بحث عن الصنف
          <input type="search" value={search} maxLength={120} onChange={event => setSearch(event.target.value)} />
        </label>
        <Button type="submit" size="compact">بحث</Button>
        <Button variant="secondary" size="compact" onClick={() => void result.refetch()}>تحديث</Button>
        <Button variant="secondary" size="compact" onClick={() => window.print()}>طباعة</Button>
      </form>
      {result.isError && <Notice tone="error">{errorMessage(result.error)}</Notice>}
      {result.isPending && <Notice>جارٍ تحميل سجل الطلبيات…</Notice>}
      {!!result.data && <>
        <div role="region" tabIndex={0} aria-label="سجل الطلبيات المرحلة"
          style={{ maxHeight:"68vh", overflow:"auto", border:"1px solid var(--border, #888)", borderRadius:6 }}>
          <table className="data-table" dir="rtl" style={{ width:"100%", minWidth:560, borderCollapse:"collapse", fontSize:13, tableLayout:"auto" }}>
            <thead><tr><th>{heading("name", "الصنف")}</th><th>{heading("required", "الكمية المطلوبة")}</th><th>{heading("available", "المتوفر وقت الترحيل دون المرتجعات")}</th><th>{heading("date", "تاريخ الترحيل")}</th></tr></thead>
            <tbody>
              {sortedItems.map(row => <tr key={row.id}>
                <td><Link to={`/companies/${companyId}/items/${row.itemId}`}>{row.itemName}</Link></td>
                <td dir="ltr" style={{ textAlign:"center", whiteSpace:"nowrap" }}>{quantityText(row.requiredQuantity, true)}</td>
                <td dir="ltr" style={{ textAlign:"center", whiteSpace:"nowrap" }}>{quantityText(row.availableQuantity)}</td>
                <td dir="ltr" title={row.exportedAt} style={{ textAlign:"center", whiteSpace:"nowrap" }}>{dateText(row.exportDate)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {!result.data.items.length && <Notice>لا توجد أصناف مرحلة خلال آخر 40 يومًا.</Notice>}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, marginTop:8 }}>
          <small>الإجمالي: {result.data.total} — الصفحة {page} من {totalPages}</small>
          <div style={{ display:"flex", gap:6 }}>
            <Button size="compact" variant="secondary" disabled={page<=1} onClick={() => setPage(x=>x-1)}>السابق</Button>
            <Button size="compact" variant="secondary" disabled={page>=totalPages} onClick={() => setPage(x=>x+1)}>التالي</Button>
          </div>
        </div>
      </>}
    </Card>
  </section>;
}
