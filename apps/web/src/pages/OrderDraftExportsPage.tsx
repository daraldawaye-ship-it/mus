import { Fragment, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";
import { errorMessage } from "../phase2";

import { OrderPlanningFields, type PlanningInfo } from "../OrderPlanningFields";
import { usePageDirectory } from "../page-directory";
import "./purchase-comparison.css";

function ComparisonDetails({ companyId, itemId, itemName }: { companyId: number; itemId: number; itemName: string }) {
  const { user } = useSession();
  const directory = usePageDirectory(companyId);
  const access = directory.data?.find(entry => entry.key === "company.item-options-list");
  const items = [{ id: itemId, requiredQuantity: null }];
  const result = useQuery({
    queryKey: ["item-order-draft-review", companyId, user?.id, JSON.stringify(items)],
    queryFn: ({ signal }) => api<{ items: PlanningInfo[] }>(`/companies/${companyId}/item-options-list/draft-review`,
      { method: "POST", body: { items }, signal }),
    enabled: !!user,
  });
  if (result.isError) return <Notice tone="error">{errorMessage(result.error)}</Notice>;
  if (result.isPending) return <Notice>جارٍ تحميل تفاصيل الصنف…</Notice>;
  if (!result.data?.items[0]) return <Notice>تعذّر العثور على بيانات الصنف.</Notice>;
  return <OrderPlanningFields companyId={companyId} itemId={itemId} itemName={itemName}
    info={result.data.items[0]} canEdit={!!access?.enabled && !!access.actionAccess.edit} />;
}

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

type ComparisonColumn = "itemName" | "requested" | "purchased" | "difference" | "actualPrice" | "actualValue" | "defaultPrice" | "defaultValue";

function compareQuantity(left: string, right: string) {
  const leftNegative = left.startsWith("-"), rightNegative = right.startsWith("-");
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
  const [a, fractionA = ""] = left.replace(/^-/, "").split(".");
  const [b, fractionB = ""] = right.replace(/^-/, "").split(".");
  const magnitude = a.length - b.length || a.localeCompare(b, "en") || fractionA.localeCompare(fractionB, "en");
  return leftNegative ? -magnitude : magnitude;
}

function comparisonValue(value: string | null, signed = false, currency?: string | null) {
  if (value == null) return "—";
  const prefix = signed && value !== "0" && !value.startsWith("-") ? "+" : "";
  return <><bdi dir="ltr">{prefix}{value}</bdi>{currency && <> <bdi>{currency}</bdi></>}</>;
}

function PurchaseComparison({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [params] = useSearchParams();
  const threeDays = params.get("period") === "three-days";
  const period = threeDays ? "three-days" : "yesterday";
  const comparisonColumns = {
    difference: "فارق الكمية",
    actualPrice: "سعر الشراء من الفواتير",
    actualValue: "إجمالي الفارق بسعر الفواتير",
    defaultPrice: "سعر الشراء الافتراضي",
    defaultValue: "إجمالي الفارق بالسعر الافتراضي",
    itemName: "اسم الصنف",
    requested: threeDays ? "أعلى كمية مطلوبة خلال 3 أيام" : "الكمية المطلوبة أمس",
    purchased: threeDays ? "إجمالي الكمية المشتراة خلال 3 أيام" : "إجمالي الكمية المشتراة أمس واليوم",
  };
  const [sort, setSort] = useState<{ column: ComparisonColumn; descending: boolean } | null>(null);
  const base = `/companies/${companyId}/order-draft-exports`;
  type Row = Record<ComparisonColumn, string | null> & {
    itemId: number; itemName: string; purchased: string; actualCurrency: string | null; defaultCurrency: string;
  };
  const result = useQuery({
    queryKey: ["order-purchase-comparison", companyId, user?.id, period],
    queryFn: ({ signal }) => api<{ items: Row[] }>(base + "/purchase-comparison?period=" + period, { signal }),
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
      description="بحسب تاريخ الترحيل وتاريخ فاتورة الشراء بتوقيت عدن. الفارق = المشتَرى − المطلوب. سعر الفواتير متوسط مرجّح بالكمية للوحدة الأولى."
      actions={<Link className="button button-secondary" to={base}>الطلبيات المرحلة</Link>} />
    <Card>
      <nav aria-label="فترة المقارنة" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <Link className={threeDays ? "button button-secondary" : "button button-primary"}
          aria-current={threeDays ? undefined : "page"} to="?view=purchases">طلبية أمس ومشتريات أمس واليوم</Link>
        <Link className={threeDays ? "button button-primary" : "button button-secondary"}
          aria-current={threeDays ? "page" : undefined} to="?view=purchases&period=three-days">طلبية 3 أيام ومشتريات 3 أيام</Link>
      </nav>
      <label>بحث عن الصنف<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <Button variant="secondary" size="compact" onClick={() => void result.refetch()}>تحديث</Button>
      {result.isPending && <Notice>جارٍ تحميل الأصناف…</Notice>}
      {result.isError && <Notice tone="error">{errorMessage(result.error)}</Notice>}
      {rows && <>
        <small>عدد الأصناف: {rows.length}</small>
        <div className="purchase-comparison-scroll"><table className="purchase-comparison-table" dir="rtl">
          <thead><tr>{heading("itemName")}{heading("requested")}{heading("purchased")}{heading("difference")}{heading("actualPrice")}{heading("actualValue")}{heading("defaultPrice")}{heading("defaultValue")}</tr></thead>
          <tbody>{rows.map((row, index) => <Fragment key={row.itemId}><tr className={index % 2 ? "alternate" : undefined}>
            <td><div className="purchase-comparison-name"><button type="button" className="item-order-draft-expand-button"
              aria-expanded={expanded === row.itemId} aria-label={`تفاصيل الصنف ${row.itemName}`}
              onClick={() => setExpanded(current => current === row.itemId ? null : row.itemId)}>⋯</button>
              <Link to={`/companies/${companyId}/items/${row.itemId}`}>{row.itemName}</Link></div></td>
            <td>{row.requested ?? "—"}</td><td>{row.purchased}</td>
            <td>{comparisonValue(row.difference, true)}</td>
            <td>{comparisonValue(row.actualPrice, false, row.actualCurrency)}</td>
            <td>{comparisonValue(row.actualValue, true, row.actualCurrency)}</td>
            <td>{comparisonValue(row.defaultPrice, false, row.defaultCurrency)}</td>
            <td>{comparisonValue(row.defaultValue, true, row.defaultCurrency)}</td>
          </tr>{expanded === row.itemId && <tr className="purchase-comparison-details"><td colSpan={8}>
            <ComparisonDetails companyId={companyId} itemId={row.itemId} itemName={row.itemName} />
          </td></tr>}</Fragment>)}</tbody>
        </table></div>
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
