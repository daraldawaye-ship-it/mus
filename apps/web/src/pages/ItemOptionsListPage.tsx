import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";
import { firstUnitStockText } from "../sale-stock-quantity";
import { rememberRecentEntity } from "../recent-entities";
import { useTemporaryItemList } from "../temporary-item-list";

const ranges = [
  { key: "stockMin", label: "الكمية المتوفرة (بدون مخازن المرتجعات) من" },
  { key: "stockMax", label: "الكمية المتوفرة (بدون مخازن المرتجعات) إلى" },
  { key: "monthMin", label: "المبيعات مرات في شهر من" },
  { key: "monthMax", label: "المبيعات مرات في شهر إلى" },
  { key: "fourMonthsMin", label: "المبيعات مرات في 4 أشهر من" },
  { key: "fourMonthsMax", label: "المبيعات مرات في 4 أشهر إلى" },
  { key: "allTimeMin", label: "المبيعات مرات منذ البداية من" },
  { key: "allTimeMax", label: "المبيعات مرات منذ البداية إلى" },
  { key: "coverageMin", label: "الكفاية من (يوم)" },
  { key: "coverageMax", label: "الكفاية إلى (يوم)" },
] as const;
type RangeKey = (typeof ranges)[number]["key"];
type Draft = Record<RangeKey, string> & { excludeZero: boolean; useReserve: boolean };
function readDraft(params: URLSearchParams): Draft {
  return {
    stockMin: params.get("stockMin") ?? "", stockMax: params.get("stockMax") ?? "",
    monthMin: params.get("monthMin") ?? "", monthMax: params.get("monthMax") ?? "",
    fourMonthsMin: params.get("fourMonthsMin") ?? "", fourMonthsMax: params.get("fourMonthsMax") ?? "",
    allTimeMin: params.get("allTimeMin") ?? "", allTimeMax: params.get("allTimeMax") ?? "",
    coverageMin: params.get("coverageMin") ?? "", coverageMax: params.get("coverageMax") ?? "",
    excludeZero: params.get("excludeZero") === "true",
    useReserve: params.get("useReserve") !== "false",
  };
}
type Row = {
  itemId: number; code: string; name: string; active: boolean;
  factor2: number; factor3: number; availableSmallest: string;
  availableUnit1: string; saleTimesMonth: string; saleTimesFourMonths: string;
  saleTimesAllTime: string; approximateCoverageDays: string | null;
  coverageAfterReserveDays: string | null;
};
type Response = {
  result: { rows: Row[]; total: number; page: number; pageSize: number; asOf: string };
};
const sortOptions = [
  ["code", "رمز الصنف"], ["name", "اسم الصنف"],
  ["stock", "الكمية المتوفرة"], ["month", "مرات المبيعات في شهر"],
  ["fourMonths", "مرات المبيعات في 4 أشهر"], ["allTime", "مرات المبيعات منذ البداية"],
  ["coverage", "الكفاية"],
] as const;
export function ItemOptionsListPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const temporarySelection = useTemporaryItemList(companyId, user?.id, "selected");
  const temporaryOrder = useTemporaryItemList(companyId, user?.id, "order");
  const [optionsCollapsed, setOptionsCollapsed] = useState(false);
  const [showOrderDraft, setShowOrderDraft] = useState(false);
  const [printMode, setPrintMode] = useState<"selected" | "order">("selected");
  const [actionMessage, setActionMessage] = useState("");
  const directory = usePageDirectory(companyId);
  const canView = !!directory.data?.find(row => row.key === "company.item-options-list")?.actionAccess.view;
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Draft>(() => readDraft(params));
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [filterError, setFilterError] = useState("");
  const paramsKey = params.toString();
  useEffect(() => {
    setDraft(readDraft(new URLSearchParams(paramsKey)));
    setSearch(new URLSearchParams(paramsKey).get("q") ?? "");
  }, [paramsKey]);
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const pageSize = [20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize")) : 50;
  const numberPattern = /^-?\\d{1,15}(?:\\.\\d{1,6})?$/;
  const active = (["active", "archived", "all"] as const).find(
    value => value === params.get("active")) ?? "active";
  const sortBy = sortOptions.find(([key]) => key === params.get("sortBy"))?.[0] ?? "code";
  const sortDir = params.get("sortDir") === "desc" ? "desc" : "asc";
  // Only forward fields supported by this list's API. URL parameters from
  // navigation, older links, and other pages must never turn the list into a 400.
  const request = new URLSearchParams();
  request.set("page", String(page));
  request.set("pageSize", String(pageSize));
  request.set("active", active);
  request.set("sortBy", sortBy);
  request.set("sortDir", sortDir);
  const q = params.get("q")?.trim();
  if (q) request.set("q", q.slice(0, 120));
  for (const { key } of ranges) {
    const value = params.get(key)?.trim();
    if (value && numberPattern.test(value)) request.set(key, value);
  }
  if (params.get("excludeZero") === "true") request.set("excludeZero", "true");
  if (params.get("useReserve") === "false") request.set("useReserve", "false");
  const resultQuery = useQuery({
    queryKey: ["item-options-list", user?.id, companyId, request.toString()],
    queryFn: ({ signal }) => api<Response>(
      `/companies/${companyId}/item-options-list?${request.toString()}`, { signal }),
    enabled: !!user && canView,
    staleTime: 0,
  });
  const result = resultQuery.data?.result;
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / pageSize));
  const selectedIds = new Set(temporarySelection.items.map(row => row.id));
  const printItems = printMode === "selected" ? temporarySelection.items : temporaryOrder.items;
  function printSelection(mode: "selected" | "order") {
    const list = mode === "selected" ? temporarySelection.items : temporaryOrder.items;
    if (!list.length) return;
    flushSync(() => setPrintMode(mode));
    window.print();
  }
  function resetTemporarySelection() {
    if (!temporarySelection.items.length) return;
    if (!window.confirm(`هل تريد تصفير جميع الاختيارات المؤقتة (${temporarySelection.items.length} صنف)؟ لا تُحذف مسودة الطلبية.`)) return;
    if (temporarySelection.clear()) setActionMessage("تم تصفير جميع الاختيارات المؤقتة. يمكنك بدء مهمة جديدة.");
  }
  function addToOrderDraft() {
    if (!temporarySelection.items.length) return;
    if (temporaryOrder.addMany(temporarySelection.items)) {
      setShowOrderDraft(true);
      setActionMessage("أُضيفت الأصناف المختارة إلى مسودة طلبية على هذا الجهاز دون تكرار. لم تُنشأ طلبية شراء رسمية.");
    }
  }
  const change = (key: string, value: string) => {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      if (key !== "page") next.delete("page");
      return next;
    });
  };
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = ranges.find(({ key }) =>
      draft[key].trim() && !numberPattern.test(draft[key].trim()));
    if (invalid) {
      setFilterError(`حقل «${invalid.label}» غير صالح. أدخل رقمًا حتى 6 منازل عشرية، أو اتركه فارغًا.`);
      return;
    }
    setFilterError("");
    setParams(previous => {
      const next = new URLSearchParams(previous);
      for (const { key } of ranges) {
        const value = draft[key].trim();
        if (value) next.set(key, value); else next.delete(key);
      }
      if (search.trim()) next.set("q", search.trim()); else next.delete("q");
      if (draft.excludeZero) next.set("excludeZero", "true"); else next.delete("excludeZero");
      if (!draft.useReserve) next.set("useReserve", "false"); else next.delete("useReserve");
      next.delete("page");
      return next;
    });
  }
  function reset() {
    setFilterError("");
    setDraft(readDraft(new URLSearchParams()));
    setSearch("");
    setParams(new URLSearchParams());
  }
  const coverage = (row: Row) => params.get("useReserve") === "false"
    ? row.approximateCoverageDays : row.coverageAfterReserveDays;
  type SortColumn = (typeof sortOptions)[number][0];
  const activeSort = sortBy;
  const activeDirection = sortDir;
  function selectSortColumn(column: SortColumn) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set("sortBy", column);
      next.set("sortDir", column === "code" || column === "name" ? "asc" : "desc");
      next.delete("page");
      return next;
    });
  }
  function reverseSortDirection() {
    change("sortDir", activeDirection === "asc" ? "desc" : "asc");
  }
  function rememberItem(row: Row) {
    if (user) rememberRecentEntity(user.id, companyId, "item",
      { id: row.itemId, name: row.name });
  }
  function sortByColumn(column: SortColumn) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      const isSameColumn = (previous.get("sortBy") ?? "code") === column;
      const currentDirection = previous.get("sortDir") ?? "asc";
      const nextDirection = isSameColumn
        ? (currentDirection === "asc" ? "desc" : "asc")
        : (column === "code" || column === "name" ? "asc" : "desc");
      next.set("sortBy", column);
      next.set("sortDir", nextDirection);
      next.delete("page");
      return next;
    });
  }
  function sortHeader(column: SortColumn, label: string) {
    const selected = activeSort === column;
    return <th key={column} aria-sort={selected
      ? (activeDirection === "asc" ? "ascending" : "descending") : "none"}>
      <button className="sort-button" type="button"
        onClick={() => sortByColumn(column)}
        title={selected ? "اضغط لعكس الترتيب" : "اضغط للترتيب حسب هذا العمود"}>
        {label}{selected &&
          <span className="sort-indicator" aria-hidden="true">
            {activeDirection === "asc" ? " ▲" : " ▼"}
          </span>}
      </button>
    </th>;
  }

  return <div className="wallet-page">
    <PageHeader title="قائمة الأصناف"
      description="تصفية الأصناف حسب المتوفر ومرات المبيعات والكفاية — دون احتساب مخازن المرتجعات في المتوفر"
      actions={<>
        <Button onClick={() => printSelection("selected")}
          disabled={!canView || !temporarySelection.items.length}>
          طباعة الأصناف المختارة ({temporarySelection.items.length})
        </Button>
        <Button variant="secondary" onClick={() => setOptionsCollapsed(value => !value)}>
          {optionsCollapsed ? "إظهار الخيارات" : "تصغير الخيارات"}
        </Button>
        <Button variant="secondary" onClick={resetTemporarySelection}
          disabled={!temporarySelection.items.length}>تصفير الاختيار المؤقت للكل</Button>
        <Link className="button button-secondary" to={`/companies/${companyId}/items`}>كروت الأصناف</Link>
        <Button variant="secondary" onClick={() => void resultQuery.refetch()}
          disabled={!canView || resultQuery.isFetching}>تحديث القائمة</Button>
      </>} />
    {directory.isPending && <Notice>جارٍ التحقق من صلاحيات القائمة…</Notice>}
    {!directory.isPending && !canView &&
      <Notice tone="warning">تحتاج الصفحة إلى صلاحيات الأصناف والمبيعات والمخزون والكفاية.</Notice>}
    {actionMessage && <Notice>{actionMessage}</Notice>}
    {temporarySelection.error && <Notice tone="error">{temporarySelection.error}</Notice>}
    {temporaryOrder.error && <Notice tone="error">{temporaryOrder.error}</Notice>}
    {!optionsCollapsed && <Card title="خيارات قائمة الأصناف">
      <form onSubmit={apply}>
        <div className="form-grid">
          <Field label="بحث عن صنف بالاسم أو الرمز أو الباركود" type="search"
            maxLength={120} value={search} onChange={event => setSearch(event.target.value)} />
          <Select label="حالة الصنف" value={active}
            onChange={event => change("active", event.target.value)}>
            <option value="active">الفعال</option>
            <option value="archived">المؤرشف</option>
            <option value="all">الكل</option>
          </Select>
          {ranges.map(({ key, label }) =>
            <Field key={key} label={label} type="number" step="any"
              placeholder="بدون حد" value={draft[key]}
              onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />
          )}
        </div>
        <div className="form-actions">
          <label className="checkbox">
            <input type="checkbox" checked={draft.excludeZero}
              onChange={event => setDraft(previous => ({ ...previous, excludeZero: event.target.checked }))} />
            استثناء الأصناف ذات الكمية الصفرية
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.useReserve}
              onChange={event => setDraft(previous => ({ ...previous, useReserve: event.target.checked }))} />
            استخدام الكفاية مع الاحتياطي
          </label>
          <Button type="submit" disabled={!canView}>تطبيق الخيارات</Button>
          <Button type="button" variant="secondary" onClick={reset}>إعادة الافتراضيات</Button>
        </div>
      </form>
    </Card>}
    {filterError && <Notice tone="error">{filterError}</Notice>}
    {resultQuery.error && <Notice tone="error">
      {errorMessage(resultQuery.error)}
      {" "}إذا استمرت المشكلة اضغط «إعادة الافتراضيات» ثم «تحديث القائمة».
    </Notice>}
    <Card title="نتائج قائمة الأصناف">
      <div className="item-options-selection-tools">
        <span>المختار مؤقتًا: <strong>{temporarySelection.items.length.toLocaleString("en-US")}</strong> صنف</span>
        <Button variant="secondary" disabled={!temporarySelection.items.length}
          onClick={addToOrderDraft}>إضافة المختارة إلى مسودة طلبية</Button>
        <Button variant="secondary" onClick={() => setShowOrderDraft(value => !value)}>
          {showOrderDraft ? "إخفاء مسودة الطلبية" : `مسودة الطلبية (${temporaryOrder.items.length})`}
        </Button>
      </div>
      {showOrderDraft && <div className="item-options-order-draft">
        <p className="muted">مسودة محفوظة على هذا المتصفح فقط، ليست طلبية شراء معتمدة.</p>
        {temporaryOrder.items.map(item => <div key={item.id} className="item-options-order-row">
          <span>{item.name}</span>
          <Button size="compact" variant="ghost"
            onClick={() => temporaryOrder.toggle(item, false)}>إزالة</Button>
        </div>)}
        {!temporaryOrder.items.length && <p>مسودة الطلبية فارغة.</p>}
        <div className="form-actions">
          <Button disabled={!temporaryOrder.items.length}
            onClick={() => printSelection("order")}>طباعة مسودة الطلبية بعمودين</Button>
          <Button variant="secondary" disabled={!temporaryOrder.items.length}
            onClick={() => {
              if (window.confirm("هل تريد تصفير مسودة الطلبية المحفوظة على الجهاز؟")) temporaryOrder.clear();
            }}>تصفير مسودة الطلبية</Button>
        </div>
      </div>}
      {result && <p className="muted">
        إجمالي الأصناف المطابقة: <bdi>{result.total.toLocaleString("en-US")}</bdi>
        {" "}· التاريخ: <bdi>{result.asOf}</bdi>
        {" "}· الصفحة <bdi>{page.toLocaleString("en-US")}</bdi> من <bdi>{pages.toLocaleString("en-US")}</bdi>
      </p>}
      <div className="form-actions item-options-result-controls">
        <div className="item-options-mobile-sort-controls">
          <Select label="الترتيب حسب العمود" value={activeSort}
            onChange={event => selectSortColumn(event.target.value as SortColumn)}>
            {sortOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </Select>
          <Button variant="secondary" type="button" onClick={reverseSortDirection}>
            {activeDirection === "asc" ? "▲ تصاعدي" : "▼ تنازلي"}
          </Button>
        </div>
        <Select label="الأصناف في الصفحة" value={String(pageSize)}
          onChange={event => change("pageSize", event.target.value)}>
          <option value="20">20</option><option value="50">50</option><option value="100">100</option>
        </Select>
      </div>
      {resultQuery.isPending && canView && <Notice>جارٍ تحميل الأصناف المطابقة…</Notice>}
      {result && <>
        <div className="item-options-mobile-list" role="list" aria-label="قائمة الأصناف للهاتف">
          {result.rows.map(row => <article key={row.itemId} className="item-options-mobile-entry" role="listitem">
            <div className="item-options-mobile-heading">
              <Link to={`/companies/${companyId}/items/${row.itemId}`}
                onClick={() => rememberItem(row)}>{row.name}</Link>
              {!row.active && <span className="item-options-mobile-inactive"> (مؤرشف)</span>}
              <label className="item-options-mobile-select">
                <input type="checkbox" aria-label={`اختيار مؤقت للصنف ${row.name}`}
                  checked={selectedIds.has(row.itemId)}
                  onChange={event => temporarySelection.toggle(
                    { id: row.itemId, name: row.name, code: row.code }, event.target.checked)} />
                اختيار مؤقت
              </label>
            </div>
            <div className="item-options-mobile-stats" aria-label="المتوفر ومرات البيع والكفاية">
              <div className="item-options-mobile-stat">
                <span>المتوفر</span><bdi>{firstUnitStockText(row.availableSmallest, row)}</bdi>
              </div>
              <div className="item-options-mobile-stat">
                <span>شهر</span><bdi>{row.saleTimesMonth}</bdi>
              </div>
              <div className="item-options-mobile-stat">
                <span>4 أشهر</span><bdi>{row.saleTimesFourMonths}</bdi>
              </div>
              <div className="item-options-mobile-stat">
                <span>منذ البداية</span><bdi>{row.saleTimesAllTime}</bdi>
              </div>
              <div className="item-options-mobile-stat">
                <span>الكفاية/يوم</span><bdi>{coverage(row) ?? "—"}</bdi>
              </div>
            </div>
          </article>)}
          {!result.rows.length && <p className="muted">لا توجد أصناف تطابق الخيارات الحالية.</p>}
        </div>
        <div className="table-scroll item-options-desktop-table" role="region"
          aria-label="نتائج الأصناف حسب الخيارات">
        <table>
          <thead><tr>
            <th scope="col">اختيار مؤقت</th>
            {sortHeader("name", "اسم الصنف")}
            {sortHeader("stock", "المتوفر دون المرتجعات (الوحدة الأولى)")}
            {sortHeader("month", "مبيعات مرات في شهر")}
            {sortHeader("fourMonths", "مبيعات مرات في 4 أشهر")}
            {sortHeader("allTime", "مبيعات مرات منذ البداية")}
            {sortHeader("coverage", "الكفاية (يوم)")}
          </tr></thead>
          <tbody>
            {result.rows.map(row => <tr key={row.itemId}>
              <td><label className="item-options-table-choice">
                <input type="checkbox" aria-label={`اختيار مؤقت للصنف ${row.name}`}
                  checked={selectedIds.has(row.itemId)}
                  onChange={event => temporarySelection.toggle(
                    { id: row.itemId, name: row.name, code: row.code }, event.target.checked)} />
                <span>اختيار</span>
              </label></td>
              <td><Link to={`/companies/${companyId}/items/${row.itemId}`}
                onClick={() => rememberItem(row)}>{row.name}</Link>{!row.active && " (مؤرشف)"}</td>
              <td><bdi>{firstUnitStockText(row.availableSmallest, row)}</bdi></td>
              <td><bdi>{row.saleTimesMonth}</bdi></td>
              <td><bdi>{row.saleTimesFourMonths}</bdi></td>
              <td><bdi>{row.saleTimesAllTime}</bdi></td>
              <td><bdi>{coverage(row) ?? "—"}</bdi></td>
            </tr>)}
            {!result.rows.length && <tr><td colSpan={7}>لا توجد أصناف تطابق الخيارات الحالية.</td></tr>}
          </tbody>
        </table>
        </div>
      </>}
      {result && <div className="form-actions">
        <Button variant="secondary" disabled={resultQuery.isFetching || page <= 1}
          onClick={() => change("page", String(page - 1))}>السابق</Button>
        <span>صفحة <bdi>{page.toLocaleString("en-US")}</bdi> من <bdi>{pages.toLocaleString("en-US")}</bdi></span>
        <Button variant="secondary" disabled={resultQuery.isFetching || page >= pages}
          onClick={() => change("page", String(page + 1))}>التالي</Button>
      </div>}
      <small className="muted">
        الحقول الفارغة لا تضع أي حد أعلى أو أدنى، وتُحتسب مرات البيع صافي عدد فواتير البيع
        بعد طرح مرتجعات المبيعات. المتوفر يستبعد مخازن المرتجعات ويُعرض بالوحدة الأولى.
        تعتمد الكفاية على حسابات الموقع الحالية مع الاحتياطي أو بدونه حسب اختيارك.
      </small>
    </Card>
    <section className="item-options-print-sheet" dir="rtl" aria-label="طباعة الأصناف المختارة">
      <header>
        <h1>{printMode === "selected" ? "الأصناف المختارة مؤقتًا" : "مسودة طلبية أصناف"}</h1>
        <p>{context.company.name} — عدد الأصناف: {printItems.length} — {new Date().toLocaleDateString("ar-YE")}</p>
      </header>
      <div className="item-options-print-columns">
        {printItems.map((item, index) => <div className="item-options-print-row" key={item.id}>
          <bdi>{index + 1}.</bdi>
          <span>{item.name}</span>
        </div>)}
      </div>
    </section>
  </div>;
}
