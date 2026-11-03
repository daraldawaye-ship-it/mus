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
import { useSharedItemSelection } from "../shared-item-selection";
import { ItemReserveQuickEdit } from "../ItemReserveQuickEdit";
import { createTwoColumnItemNamesPdf, exportPdfToDevice } from "../item-names-pdf";
import { itemOptionsPresetFiltersSchema, type ItemOptionsPreset, type ItemOptionsPresetFilters } from "../../../../packages/contracts/src/item-options-presets.ts";

const ranges = [
  { key: "stockMin", label: "الكمية المتوفرة (بدون مخازن المرتجعات) من" },
  { key: "stockMax", label: "الكمية المتوفرة (بدون مخازن المرتجعات) إلى" },
  { key: "reserveMin", label: "الكمية احتياط من" },
  { key: "reserveMax", label: "الكمية احتياط إلى" },
  { key: "monthMin", label: "المبيعات مرات في شهر من" },
  { key: "monthMax", label: "المبيعات مرات في شهر إلى" },
  { key: "fourMonthsMin", label: "المبيعات مرات في 4 أشهر من" },
  { key: "fourMonthsMax", label: "المبيعات مرات في 4 أشهر إلى" },
  { key: "allTimeMin", label: "المبيعات مرات منذ البداية من" },
  { key: "allTimeMax", label: "المبيعات مرات منذ البداية إلى" },
  { key: "previousYearMin", label: "مرات عام السابق من" },
  { key: "previousYearMax", label: "مرات عام السابق إلى" },
  { key: "coverageMin", label: "الكفاية من (يوم)" },
  { key: "coverageMax", label: "الكفاية إلى (يوم)" },
] as const;
type RangeKey = (typeof ranges)[number]["key"];
type Draft = Record<RangeKey, string> & { excludeZero: boolean; useReserve: boolean };
function readDraft(params: URLSearchParams): Draft {
  return {
    stockMin: params.get("stockMin") ?? "1", stockMax: params.get("stockMax") ?? "1",
    reserveMin: params.get("reserveMin") ?? "", reserveMax: params.get("reserveMax") ?? "",
    monthMin: params.get("monthMin") ?? "", monthMax: params.get("monthMax") ?? "",
    fourMonthsMin: params.get("fourMonthsMin") ?? "", fourMonthsMax: params.get("fourMonthsMax") ?? "",
    allTimeMin: params.get("allTimeMin") ?? "", allTimeMax: params.get("allTimeMax") ?? "",
    previousYearMin: params.get("previousYearMin") ?? "", previousYearMax: params.get("previousYearMax") ?? "",
    coverageMin: params.get("coverageMin") ?? "", coverageMax: params.get("coverageMax") ?? "",
    excludeZero: params.get("excludeZero") === "true",
    useReserve: params.get("useReserve") !== "false",
  };
}
type Row = {
  itemId: number; code: string; name: string; active: boolean;
  revision: number; reserveQuantity: string;
  factor2: number; factor3: number; availableSmallest: string;
  availableUnit1: string; saleTimesMonth: string; saleTimesFourMonths: string;
  saleTimesAllTime: string; saleTimesPreviousYear: string | null;
  approximateCoverageDays: string | null;
  coverageAfterReserveDays: string | null;
};
type Response = {
  result: { rows: Row[]; total: number; page: number; pageSize: number; asOf: string };
};
const sortOptions = [
  ["code", "رمز الصنف"], ["name", "اسم الصنف"],
  ["stock", "الكمية المتوفرة"], ["reserve", "الكمية احتياط"],
  ["month", "مرات المبيعات في شهر"],
  ["fourMonths", "مرات المبيعات في 4 أشهر"], ["allTime", "مرات المبيعات منذ البداية"],
  ["previousYear", "مرات عام السابق"],
  ["coverage", "الكفاية"],
] as const;
export function ItemOptionsListPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const temporarySelection = useSharedItemSelection(companyId, user?.id);
  const temporaryOrder = useTemporaryItemList(companyId, user?.id, "order");
  const [optionsCollapsed, setOptionsCollapsed] = useState(false);
  const [showOrderDraft, setShowOrderDraft] = useState(false);
  const [printMode, setPrintMode] = useState<"selected" | "order">("selected");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const directory = usePageDirectory(companyId);
  const itemListPage = directory.data?.find(row => row.key === "company.item-options-list");
  const canView = !!itemListPage?.enabled && !!itemListPage.actionAccess.view;
  const canEditReserve = !!itemListPage?.enabled && !!itemListPage.actionAccess.edit;
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Draft>(() => readDraft(params));
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [filterError, setFilterError] = useState("");
  const [presetName, setPresetName] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetMessage, setPresetMessage] = useState<{tone:"error"|"success";text:string}|null>(null);
  const presetBase = `/companies/${companyId}/item-options-list/presets`;
  const presetsQuery = useQuery({
    queryKey: ["company-item-options-presets", companyId, user?.id],
    queryFn: ({signal}) => api<{items:ItemOptionsPreset[]}>(presetBase,{signal}),
    enabled: !!user && canView,
    staleTime: 0,
    refetchInterval: 60_000,
  });
  const presets = presetsQuery.data?.items ?? [];
  const selectedPreset = presets.find(row => String(row.id) === selectedPresetId);
  const canDeletePresets = Boolean(user?.owner || canEditReserve);

  const paramsKey = params.toString();
  useEffect(() => {
    setDraft(readDraft(new URLSearchParams(paramsKey)));
    setSearch(new URLSearchParams(paramsKey).get("q") ?? "");
  }, [paramsKey]);
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const pageSize = [20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize")) : 50;
  const numberPattern = /^-?\d{1,15}(?:\.\d{1,6})?$/;
  const active = (["active", "archived", "all"] as const).find(
    value => value === params.get("active")) ?? "active";
  const sortBy = sortOptions.find(([key]) => key === params.get("sortBy"))?.[0] ?? "allTime";
  const sortDir = params.get("sortDir") === "asc" ? "asc" : "desc";
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
    // Initial defaults are exactly one first-unit item. A deliberately blank
    // URL value remains unbounded, unlike an absent parameter.
    const value = (params.get(key) ??
      (key === "stockMin" || key === "stockMax" ? "1" : "")).trim();
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
  async function exportSelectionPdf(mode: "selected" | "order") {
    if (exportingPdf) return;
    const list = mode === "selected" ? temporarySelection.items : temporaryOrder.items;
    if (!list.length) return;
    setExportingPdf(true);
    setActionMessage("");
    try {
      // Real PDF bytes, not the browser's print-to-PDF dialog; Arabic lettering
      // is shaped by the device and each A4 page has exactly two columns.
      const pdf = createTwoColumnItemNamesPdf(list.map(item => item.name));
      const today = new Date().toLocaleDateString("en-CA");
      const filename = `${mode === "selected" ? "selected-items" : "item-order-draft"}-${today}.pdf`;
      const result = await exportPdfToDevice(pdf, filename);
      if (result === "shared")
        setActionMessage("أُنشئ PDF وتم تسليمه إلى مشاركة الجهاز. يمكنك حفظه في الملفات أو إرساله.");
      else if (result === "downloaded")
        setActionMessage("تم تجهيز ملف PDF وتنزيله عبر المتصفح. تحقق من مجلد التنزيلات.");
    } catch (reason) {
      setActionMessage(`تعذر تصدير PDF: ${errorMessage(reason)}`);
    } finally {
      setExportingPdf(false);
    }
  }
  async function resetTemporarySelection() {
    if (!temporarySelection.items.length) return;
    if (!window.confirm(`سيتم تصفير جميع الاختيارات المؤقتة (${temporarySelection.items.length} صنف) لكل مستخدمي الشركة وعلى جميع الأجهزة. هل تريد المتابعة؟ مسودات الطلبيات المحلية لن تُحذف.`)) return;
    if (await temporarySelection.clear())
      setActionMessage("تم تصفير الاختيارات المشتركة على مستوى الشركة، ويمكن بدء مهمة جديدة من أي جهاز.");
  }
  function addToOrderDraft() {
    if (!temporarySelection.items.length) return;
    if (temporaryOrder.addMany(temporarySelection.items)) {
      setShowOrderDraft(true);
      setActionMessage("نُسخت الأصناف المشتركة إلى مسودة الطلبية المحلية على هذا الجهاز دون تكرار؛ لم تُنشأ طلبية شراء رسمية.");
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
        // Preserve an explicitly empty quantity range so the user can request
        // "without limit" instead of silently restoring the default of 1.
        if (value || key === "stockMin" || key === "stockMax")
          next.set(key, value);
        else next.delete(key);
      }
      if (search.trim()) next.set("q", search.trim()); else next.delete("q");
      if (draft.excludeZero) next.set("excludeZero", "true"); else next.delete("excludeZero");
      if (!draft.useReserve) next.set("useReserve", "false"); else next.delete("useReserve");
      next.delete("page");
      return next;
    });
  }
  // Save draft controls, including un-applied range edits, but not page number.
  function currentPresetFilters(): ItemOptionsPresetFilters | null {
    const candidate = {
      q: search.trim(), active, sortBy, sortDir,
      ...Object.fromEntries(ranges.map(({key}) => [key,draft[key].trim()])),
      excludeZero: draft.excludeZero,
      useReserve: draft.useReserve,
    };
    const result = itemOptionsPresetFiltersSchema.safeParse(candidate);
    if (!result.success) {
      setPresetMessage({tone:"error",text:"تحقق من حدود الفلاتر (حتى 6 منازل عشرية) ثم أعد الحفظ."});
      return null;
    }
    return result.data;
  }
  async function savePreset() {
    if (!canView || presetBusy) return;
    const name = presetName.trim();
    if (!name || name.length > 80) {
      setPresetMessage({tone:"error",text:"اكتب اسمًا للفلتر المحفوظ لا يزيد عن 80 حرفًا."});
      return;
    }
    const filters = currentPresetFilters();
    if (!filters) return;
    setPresetBusy(true);
    setPresetMessage(null);
    try {
      const result = await api<{item:ItemOptionsPreset}>(presetBase,{
        method:"POST", body:{name,filters},
      });
      setPresetName("");
      setSelectedPresetId(String(result.item.id));
      setPresetMessage({tone:"success",text:`حُفظ الفلتر «${result.item.name}» وأصبح متاحًا لجميع مستخدمي الشركة.`});
      await presetsQuery.refetch();
    } catch(cause) {
      setPresetMessage({tone:"error",text:errorMessage(cause)});
    } finally { setPresetBusy(false); }
  }
  function applyPreset(preset: ItemOptionsPreset) {
    const filters = itemOptionsPresetFiltersSchema.safeParse(preset.filters);
    if (!filters.success) {
      setPresetMessage({tone:"error",text:"الفلاتر المحفوظة غير صالحة. اختر مجموعة أخرى."});
      return;
    }
    const values = filters.data;
    const next = new URLSearchParams();
    next.set("active",values.active);
    next.set("sortBy",values.sortBy);
    next.set("sortDir",values.sortDir);
    next.set("pageSize",String(pageSize));
    if(values.q) next.set("q",values.q);
    for(const {key} of ranges) next.set(key,values[key]);
    if(values.excludeZero) next.set("excludeZero","true");
    if(!values.useReserve) next.set("useReserve","false");
    setDraft(readDraft(next));
    setSearch(values.q);
    setFilterError("");
    setPresetMessage(null);
    setOptionsCollapsed(false);
    setParams(next);
  }
  async function deletePreset(preset: ItemOptionsPreset) {
    if (!canDeletePresets || presetBusy) return;
    if (!window.confirm(`هل تريد حذف الفلتر المشترك «${preset.name}» من الشركة للجميع؟`)) return;
    setPresetBusy(true);
    setPresetMessage(null);
    try {
      await api(`${presetBase}/${preset.id}`,{method:"DELETE",body:{}});
      setSelectedPresetId("");
      setPresetMessage({tone:"success",text:`حُذف الفلتر «${preset.name}» من القوائم المشتركة.`});
      await presetsQuery.refetch();
    } catch(cause) {
      setPresetMessage({tone:"error",text:errorMessage(cause)});
    } finally { setPresetBusy(false); }
  }
  function reset() {
    setFilterError("");
    const defaults = new URLSearchParams({
      stockMin: "1", stockMax: "1", sortBy: "allTime", sortDir: "desc",
    });
    setDraft(readDraft(defaults));
    setSearch("");
    setParams(defaults);
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
      const isSameColumn = (previous.get("sortBy") ?? "allTime") === column;
      const currentDirection = previous.get("sortDir") ?? "desc";
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
        <Button variant="secondary" onClick={() => void exportSelectionPdf("selected")}
          disabled={!canView || exportingPdf || !temporarySelection.items.length}>
          {exportingPdf ? "جارٍ تجهيز PDF…" : "تصدير PDF للمختارة"}
        </Button>
        <Button variant="secondary" onClick={() => setOptionsCollapsed(value => !value)}>
          {optionsCollapsed ? "إظهار الخيارات" : "تصغير الخيارات"}
        </Button>
        <Button variant="secondary" onClick={resetTemporarySelection}
          disabled={!temporarySelection.items.length || temporarySelection.updating}>تصفير الاختيار المؤقت للكل</Button>
        <Link className="button button-secondary" to={`/companies/${companyId}/items`}>كروت الأصناف</Link>
        <Button variant="secondary" onClick={() => void resultQuery.refetch()}
          disabled={!canView || resultQuery.isFetching}>تحديث القائمة</Button>
      </>} />
    {directory.isPending && <Notice>جارٍ التحقق من صلاحيات القائمة…</Notice>}
    {!directory.isPending && !canView &&
      <Notice tone="warning">تحتاج الصفحة إلى صلاحيات الأصناف والمبيعات والمخزون والكفاية.</Notice>}
    {actionMessage && <Notice>{actionMessage}</Notice>}
    {temporarySelection.error && <Notice tone="error">{temporarySelection.error}</Notice>}
    {temporarySelection.updating && <small className="muted" role="status">جارٍ حفظ الاختيارات المشتركة…</small>}
    {temporaryOrder.error && <Notice tone="error">{temporaryOrder.error}</Notice>}
    {!optionsCollapsed && <Card title="خيارات قائمة الأصناف" className="item-options-filters-card">
      <form onSubmit={apply}>
        <div className="item-options-filter-scroll" role="region"
          aria-label="مرر لعرض جميع خيارات تصفية الأصناف" tabIndex={0}>
          <div className="item-options-filter-grid">
            <label className="item-options-filter-field">
              <span className="item-options-filter-label">بحث عن صنف بالاسم أو الرمز أو الباركود</span>
              <input type="search" maxLength={120} value={search}
                placeholder="اكتب الاسم أو الرمز" onChange={event => setSearch(event.target.value)} />
            </label>
            <label className="item-options-filter-field">
              <span className="item-options-filter-label">حالة الصنف</span>
              <select value={active} onChange={event => change("active", event.target.value)}>
                <option value="active">الفعال</option>
                <option value="archived">المؤرشف</option>
                <option value="all">الكل</option>
              </select>
            </label>
            {ranges.map(({ key, label }) =>
              <label className="item-options-filter-field" key={key}>
                <span className="item-options-filter-label" title={label}>{label}</span>
                <input type="number" step="any"
                  value={draft[key]}
                  onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />
              </label>
            )}
          </div>
        </div>
        <div className="form-actions item-options-filter-actions">
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
    {canView && <Card title="الفلاتر المحفوظة للجميع">
      <p className="muted">أي موظف يستطيع حفظ مجموعة فلاتر باسم، ويستطيع جميع مستخدمي الشركة استدعاءها من أي جهاز. الحذف متاح لمن لديه صلاحية تعديل الصفحة.</p>
      <div className="form-actions">
        <label className="item-options-filter-field" style={{flex:"1 1 230px"}}>
          <span className="item-options-filter-label">الفلاتر المشتركة المحفوظة</span>
          <select aria-label="الفلاتر المشتركة المحفوظة" value={selectedPresetId}
            onChange={event=>setSelectedPresetId(event.target.value)}>
            <option value="">اختر فلترًا محفوظًا</option>
            {presets.map(preset=><option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
        <Button type="button" disabled={!selectedPreset} onClick={()=>{if(selectedPreset) applyPreset(selectedPreset);}}>
          تطبيق الفلتر
        </Button>
        {canDeletePresets && <Button type="button" variant="danger" disabled={!selectedPreset || presetBusy}
          onClick={()=>{if(selectedPreset) void deletePreset(selectedPreset);}}>
          حذف الفلتر
        </Button>}
        <Button type="button" variant="secondary" disabled={presetsQuery.isFetching}
          onClick={()=>void presetsQuery.refetch()}>تحديث الفلاتر</Button>
      </div>
      {selectedPreset && <small className="muted">أضافه: {selectedPreset.createdByName}</small>}
      <form className="form-actions" onSubmit={event=>{event.preventDefault();void savePreset();}}>
        <label className="item-options-filter-field" style={{flex:"1 1 230px"}}>
          <span className="item-options-filter-label">اسم الفلتر الجديد</span>
          <input type="text" required maxLength={80} value={presetName}
            placeholder="مثال: أصناف تحتاج طلبية"
            onChange={event=>setPresetName(event.target.value)} />
        </label>
        <Button type="submit" disabled={presetBusy || !presetName.trim()}>
          {presetBusy?"جارٍ الحفظ…":"حفظ الخيارات الحالية باسم"}
        </Button>
      </form>
      {presetsQuery.error && <Notice tone="error">{errorMessage(presetsQuery.error)}</Notice>}
      {presetMessage && <Notice tone={presetMessage.tone}>{presetMessage.text}</Notice>}
    </Card>}
    {filterError && <Notice tone="error">{filterError}</Notice>}
    {resultQuery.error && <Notice tone="error">
      {errorMessage(resultQuery.error)}
      {" "}إذا استمرت المشكلة اضغط «إعادة الافتراضيات» ثم «تحديث القائمة».
    </Notice>}
    <Card title="نتائج قائمة الأصناف">
      <div className="item-options-selection-tools">
        <span>الاختيار المؤقت المشترك للشركة: <strong>{temporarySelection.items.length.toLocaleString("en-US")}</strong> صنف</span>
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
          <Button variant="secondary" disabled={exportingPdf || !temporaryOrder.items.length}
            onClick={() => void exportSelectionPdf("order")}>
            {exportingPdf ? "جارٍ تجهيز PDF…" : "تصدير مسودة الطلبية PDF"}
          </Button>
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
          {result.rows.map(row => <article key={row.itemId} className={`item-options-mobile-entry${selectedIds.has(row.itemId) ? " item-options-chosen-row" : ""}`} role="listitem">
            <div className="item-options-mobile-heading">
              <Link to={`/companies/${companyId}/items/${row.itemId}`}
                onClick={() => rememberItem(row)}>{row.name}</Link>
              {!row.active && <span className="item-options-mobile-inactive"> (مؤرشف)</span>}
              <label className="item-options-mobile-select">
                <input type="checkbox" aria-label={`اختيار مؤقت للصنف ${row.name}`}
                  checked={selectedIds.has(row.itemId)}
                  disabled={!temporarySelection.enabled || temporarySelection.pendingIds.has(row.itemId)}
                  onChange={event => void temporarySelection.toggle(
                    { id: row.itemId, name: row.name, code: row.code }, event.target.checked)} />
                {temporarySelection.pendingIds.has(row.itemId) ? "جارٍ حفظ الاختيار…" : "اختيار مؤقت"}
              </label>
            </div>
            <div className="item-options-mobile-stats" aria-label="المتوفر ومرات البيع والكفاية">
              <div className="item-options-mobile-stat">
                <span>المتوفر</span><bdi>{firstUnitStockText(row.availableSmallest, row)}</bdi>
              </div>
              <div className="item-options-mobile-stat item-options-reserve-stat">
                <span>كمية احتياط</span>
                <ItemReserveQuickEdit key={row.itemId} companyId={companyId} itemId={row.itemId}
                  revision={row.revision} reserveQuantity={row.reserveQuantity}
                  canEdit={canEditReserve} />
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
            <th scope="col">كمية احتياط</th>
            {sortHeader("month", "مبيعات مرات في شهر")}
            {sortHeader("fourMonths", "مبيعات مرات في 4 أشهر")}
            {sortHeader("allTime", "مبيعات مرات منذ البداية")}
            {sortHeader("coverage", "الكفاية (يوم)")}
          </tr></thead>
          <tbody>
            {result.rows.map(row => <tr key={row.itemId}
              className={selectedIds.has(row.itemId) ? "item-options-chosen-row" : undefined}>
              <td><label className="item-options-table-choice">
                <input type="checkbox" aria-label={`اختيار مؤقت للصنف ${row.name}`}
                  checked={selectedIds.has(row.itemId)}
                  disabled={!temporarySelection.enabled || temporarySelection.pendingIds.has(row.itemId)}
                  onChange={event => void temporarySelection.toggle(
                    { id: row.itemId, name: row.name, code: row.code }, event.target.checked)} />
                <span>{temporarySelection.pendingIds.has(row.itemId) ? "حفظ…" : "اختيار"}</span>
              </label></td>
              <td><Link to={`/companies/${companyId}/items/${row.itemId}`}
                onClick={() => rememberItem(row)}>{row.name}</Link>{!row.active && " (مؤرشف)"}</td>
              <td><bdi>{firstUnitStockText(row.availableSmallest, row)}</bdi></td>
              <td><ItemReserveQuickEdit key={row.itemId} companyId={companyId}
                itemId={row.itemId} revision={row.revision}
                reserveQuantity={row.reserveQuantity} canEdit={canEditReserve} /></td>
              <td><bdi>{row.saleTimesMonth}</bdi></td>
              <td><bdi>{row.saleTimesFourMonths}</bdi></td>
              <td><bdi>{row.saleTimesAllTime}</bdi></td>
              <td><bdi>{coverage(row) ?? "—"}</bdi></td>
            </tr>)}
            {!result.rows.length && <tr><td colSpan={8}>لا توجد أصناف تطابق الخيارات الحالية.</td></tr>}
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
    <section className="item-options-print-sheet" dir="rtl" aria-label="طباعة أسماء الأصناف دون ترويسة أو ترقيم">
      <div className="item-options-print-columns">
        {printItems.map(item => <div className="item-options-print-row" key={item.id}>
          <span>{item.name}</span>
        </div>)}
      </div>
    </section>
  </div>;
}
