import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CompanyContext, Page } from "../../../../packages/contracts/src/index.ts";
import { stockMovementKindLabels, type StockMovement } from "../../../../packages/contracts/src/inventory";
import { signedStockMovementQuantity } from "../stock-movement-display";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";
import { errorMessage } from "../phase2";

import { OrderPlanningFields, type PlanningInfo } from "../OrderPlanningFields";
import { usePageDirectory } from "../page-directory";
import { formatStockSaleQuantity } from "../order-draft-quantities";
import "./purchase-comparison.css";

type ComparisonMetrics = PlanningInfo & { itemId: number; saleQuantityMonth: string; availableUnit1: string };

type ExportRow = {
  id: number; itemId: number; itemName: string;
  requiredQuantity: string | null; availableQuantity: string;
  exportDate: string; exportedAt: string;
};
type ExportResult = { items: ExportRow[]; total: number; page: number; pageSize: number };

export function OrderDraftExportsPage({ context, comparison = false }: { context: CompanyContext; comparison?: boolean }) {
  const [params] = useSearchParams();
  return comparison || params.get("view") === "purchases"
    ? <PurchaseComparison context={context} />
    : <ExportHistory context={context} />;
}

type ComparisonColumn = "itemName" | "requested" | "purchased" | "difference" | "actualPrice" | "actualValue" | "defaultPrice" | "defaultValue" | "saleQuantityMonth" | "availableUnit1";

function compareQuantity(left: string, right: string) {
  const leftNegative = left.startsWith("-"), rightNegative = right.startsWith("-");
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
  const [a, fractionA = ""] = left.replace(/^-/, "").split(".");
  const [b, fractionB = ""] = right.replace(/^-/, "").split(".");
  const magnitude = a.length - b.length || a.localeCompare(b, "en") || fractionA.localeCompare(fractionB, "en");
  return leftNegative ? -magnitude : magnitude;
}

function comparisonValue(value: string | null, signed = false) {
  if (value == null) return "—";
  const prefix = signed && value !== "0" && !value.startsWith("-") ? "+" : "";
  return <bdi dir="ltr">{prefix}{value}</bdi>;
}

function PurchaseComparison({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [sidePanel, setSidePanel] = useState<{ itemId: number; itemName: string; view: "purchase" | "movement" } | null>(null);
  useEffect(() => {
    if (sidePanel && window.matchMedia("(max-width: 900px)").matches) {
      document.getElementById("purchase-comparison-detail-pane")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [sidePanel]);
  const [params] = useSearchParams();
  const threeDays = params.get("period") === "three-days";
  const period = threeDays ? "three-days" : "yesterday";
  const comparisonColumns = {
    saleQuantityMonth: "الكمية المباعة في شهر",
    availableUnit1: "الكمية المتوفرة دون المرتجعات",
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
  type Row = Record<Exclude<ComparisonColumn, "saleQuantityMonth" | "availableUnit1">, string | null> & {
    itemId: number; itemName: string; purchased: string; actualCurrency: string | null; defaultCurrency: string;
  };
  const result = useQuery({
    queryKey: ["order-purchase-comparison", companyId, user?.id, period],
    queryFn: ({ signal }) => api<{ items: Row[] }>(base + "/purchase-comparison?period=" + period, { signal }),
    enabled: !!user,
  });
  const directory = usePageDirectory(companyId);
  const access = directory.data?.find(entry => entry.key === "company.item-options-list");
  const batches = useMemo(() => {
    const items = (result.data?.items ?? []).map(row => ({ id: row.itemId, requiredQuantity: null }));
    return Array.from({ length: Math.ceil(items.length / 300) }, (_, i) => items.slice(i * 300, (i + 1) * 300));
  }, [result.data]);
  const metrics = useQueries({
    queries: batches.map(items => ({
      queryKey: ["item-order-draft-review", companyId, user?.id, JSON.stringify(items)],
      queryFn: ({ signal }: { signal: AbortSignal }) => api<{ items: ComparisonMetrics[] }>(
        `/companies/${companyId}/item-options-list/draft-review`, { method: "POST", body: { items }, signal }),
      staleTime: 30_000,
    })),
  });
  const byId = new Map(metrics.flatMap(batch => batch.data?.items ?? []).map(item => [item.itemId, item]));
  const metricsError = metrics.find(batch => batch.isError)?.error;
  const rows = result.data?.items.filter(row => row.itemName.includes(search.trim())).map(row => {
    const info = byId.get(row.itemId);
    return { ...row, info, saleQuantityMonth: info?.saleQuantityMonth ?? null, availableUnit1: info?.availableUnit1 ?? null };
  });
  if (sort) rows?.sort((a, b) => {
      const left = a[sort.column], right = b[sort.column];
      if (left === null || right === null) return Number(left === null) - Number(right === null);
      const order = sort.column === "itemName"
        ? left.localeCompare(right, "ar", { numeric: true })
        : compareQuantity(left, right);
      return (sort.descending ? -order : order) || a.itemId - b.itemId;
    });
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
    <div className="purchase-comparison-split-layout">
    <Card>
      <nav aria-label="فترة المقارنة" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <Link className={threeDays ? "button button-secondary" : "button button-primary"}
          aria-current={threeDays ? undefined : "page"} to="?view=purchases">طلبية أمس ومشتريات أمس واليوم</Link>
        <Link className={threeDays ? "button button-primary" : "button button-secondary"}
          aria-current={threeDays ? "page" : undefined} to="?view=purchases&period=three-days">طلبية 3 أيام ومشتريات 3 أيام</Link>
      </nav>
      <label>بحث عن الصنف<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <Button variant="secondary" size="compact" onClick={() => { void result.refetch(); metrics.forEach(batch => void batch.refetch()); }}>تحديث</Button>
      {result.isPending && <Notice>جارٍ تحميل الأصناف…</Notice>}
      {result.isError && <Notice tone="error">{errorMessage(result.error)}</Notice>}
      {metricsError && <Notice tone="error">{errorMessage(metricsError)}</Notice>}
      {rows && <>
        <small>عدد الأصناف: {rows.length}</small>
        <div className="purchase-comparison-scroll"><table className="purchase-comparison-table" dir="rtl">
          <thead><tr>{heading("itemName")}{heading("requested")}{heading("purchased")}{heading("difference")}{heading("saleQuantityMonth")}{heading("availableUnit1")}{heading("actualPrice")}{heading("actualValue")}{heading("defaultPrice")}{heading("defaultValue")}</tr></thead>
          <tbody>{rows.map((row, index) => <Fragment key={row.itemId}><tr className={[index % 2 ? "alternate" : "", sidePanel?.itemId === row.itemId ? "selected" : ""].filter(Boolean).join(" ")}>
            <td><div className="purchase-comparison-name"><button type="button" className="item-order-draft-expand-button"
              aria-expanded={expanded === row.itemId} aria-label={`تفاصيل الصنف ${row.itemName}`}
              onClick={() => setExpanded(current => current === row.itemId ? null : row.itemId)}>⋯</button>
              <button type="button" className="purchase-comparison-item-select"
                aria-pressed={sidePanel?.itemId === row.itemId}
                onClick={() => setSidePanel(current => ({ itemId: row.itemId, itemName: row.itemName, view: current?.view ?? "purchase" }))}>
                {row.itemName}
              </button>
              <Link className="purchase-comparison-item-card-link" to={`/companies/${companyId}/items/${row.itemId}`}
                title="فتح كرت الصنف" aria-label={`فتح كرت الصنف ${row.itemName}`}>↗</Link></div></td>
            <td>{row.requested ?? "—"}</td><td>{row.purchased}</td>
            <td>{comparisonValue(row.difference, true)}</td>
            <td><bdi className="item-order-drafts-sold-quantity">{formatStockSaleQuantity(row.saleQuantityMonth)}</bdi></td>
            <td><bdi className="item-order-drafts-stock-quantity">{formatStockSaleQuantity(row.availableUnit1)}</bdi></td>
            <td>{comparisonValue(row.actualPrice)}</td>
            <td>{comparisonValue(row.actualValue, true)}</td>
            <td>{comparisonValue(row.defaultPrice)}</td>
            <td>{comparisonValue(row.defaultValue, true)}</td>
          </tr>{expanded === row.itemId && <tr className="purchase-comparison-details"><td colSpan={10}>
            {!row.info && metricsError ? <Notice tone="error">{errorMessage(metricsError)}</Notice> :
              <OrderPlanningFields companyId={companyId} itemId={row.itemId} itemName={row.itemName}
                info={row.info} canEdit={!!access?.enabled && !!access.actionAccess.edit} />}
          </td></tr>}</Fragment>)}</tbody>
        </table></div>
        {!rows.length && <Notice>لا توجد أصناف مطابقة.</Notice>}
      </>}
    </Card>
    <aside id="purchase-comparison-detail-pane" className="purchase-comparison-detail-pane" aria-live="polite">
      {sidePanel && <Card>
        <div className="purchase-comparison-side-heading">
          <strong dir="auto">{sidePanel.itemName}</strong>
          <button type="button" className="purchase-comparison-close" onClick={() => setSidePanel(null)} aria-label="إغلاق تفاصيل الصنف">×</button>
        </div>
        <div className="purchase-comparison-view-switch" role="group" aria-label="نوع حركة الصنف">
          <Button size="compact" variant={sidePanel.view === "purchase" ? "primary" : "secondary"}
            onClick={() => setSidePanel(current => current && { ...current, view: "purchase" })}
            aria-pressed={sidePanel.view === "purchase"}>مشتريات الصنف</Button>
          <Button size="compact" variant={sidePanel.view === "movement" ? "primary" : "secondary"}
            onClick={() => setSidePanel(current => current && { ...current, view: "movement" })}
            aria-pressed={sidePanel.view === "movement"}>حركة الصنف</Button>
        </div>
        <PurchaseComparisonItemPanel companyId={companyId} userId={user?.id} itemId={sidePanel.itemId} view={sidePanel.view} />
      </Card>}
    </aside>
    </div>
  </section>;
}

type ComparisonHistoryRow = {
  lineId: string | number;
  documentDate: string;
  partyName?: string | null;
  quantityFirstUnit: string;
  unitPriceFirstUnit?: string | null;
  isStaged?: boolean;
};

function PurchaseComparisonItemPanel({ companyId, userId, itemId, view }: {
  companyId: number;
  userId: number | undefined;
  itemId: number;
  view: "purchase" | "movement";
}) {
  const history = useQuery<{ items: ComparisonHistoryRow[] }>({
    queryKey: ["purchase-comparison-side-purchases", companyId, userId, itemId],
    queryFn: ({ signal }) => api<{ items: ComparisonHistoryRow[] }>(
      "/companies/" + companyId + "/item-history/" + itemId + "?type=purchase", { signal }),
    enabled: !!userId && view === "purchase",
    staleTime: 10_000,
  });
  const movements = useQuery<Page<StockMovement>>({
    queryKey: ["purchase-comparison-side-movements", companyId, userId, itemId],
    queryFn: ({ signal }) => api<Page<StockMovement>>(
      "/companies/" + companyId + "/stock-movements?" + new URLSearchParams({
        itemId: String(itemId), page: "1", pageSize: "20", sort: "documentDate:desc,id:desc",
      }), { signal }),
    enabled: !!userId && view === "movement",
    staleTime: 10_000,
  });
  if (view === "purchase") return <>
    {history.isPending && <Notice>جارٍ تحميل مشتريات الصنف…</Notice>}
    {history.isError && <Notice tone="error">تعذر تحميل مشتريات الصنف: {errorMessage(history.error)}</Notice>}
    {history.data?.items.length === 0 && <small>لا توجد مشتريات سابقة لهذا الصنف.</small>}
    {!!history.data?.items.length && <div className="purchase-comparison-side-scroll" role="region" tabIndex={0} aria-label="مشتريات الصنف">
      <table className="purchase-comparison-side-table" dir="rtl">
        <thead><tr><th>التاريخ</th><th>المورد</th><th>السعر</th><th>الكمية (و1)</th></tr></thead>
        <tbody>{history.data.items.map(row => <tr key={row.lineId}>
          <td dir="ltr">{row.documentDate}{row.isStaged && <small className="muted">أوليًا</small>}</td>
          <td title={row.partyName ?? "—"}>{row.partyName || "—"}</td>
          <td dir="ltr">{row.unitPriceFirstUnit ?? "—"}</td>
          <td dir="ltr">{row.quantityFirstUnit}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </>;
  return <>
    {movements.isPending && <Notice>جارٍ تحميل حركة الصنف…</Notice>}
    {movements.isError && <Notice tone="error">تعذر تحميل حركة الصنف: {errorMessage(movements.error)}</Notice>}
    {movements.data?.items.length === 0 && <small>لا توجد حركات مخزون مرحلة لهذا الصنف.</small>}
    {!!movements.data?.items.length && <div className="purchase-comparison-side-scroll" role="region" tabIndex={0} aria-label="حركة الصنف">
      <table className="purchase-comparison-side-table" dir="rtl">
        <thead><tr><th>التاريخ</th><th>الحركة والموقع</th><th>الكمية</th></tr></thead>
        <tbody>{movements.data.items.map(row => <tr key={row.id}>
          <td dir="ltr">{row.documentDate}</td>
          <td title={row.locationName}>{stockMovementKindLabels[row.kind]} — {row.locationName}</td>
          <td dir="ltr">{signedStockMovementQuantity(row.quantitySmallest)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {movements.data && movements.data.total > movements.data.pageSize &&
      <small>تظهر آخر {movements.data.pageSize} حركة من أصل {movements.data.total}.</small>}
    <Link className="purchase-comparison-all-movements" to={"/companies/" + companyId + "/stock-movements?itemId=" + itemId}>
      عرض جميع الحركات
    </Link>
  </>;
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
      actions={<><Link className="button button-secondary" to={`/companies/${companyId}/purchase-comparison`}>فارق الشراء والطلبيه</Link> <Link className="button button-secondary" to={`/companies/${companyId}/item-order-drafts`}>متابعة المسودة</Link></>} />
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
