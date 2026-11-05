import { useEffect, useRef, useState } from "react";
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
import type { TemporaryChosenItem } from "../temporary-item-list";
import { useNumberedOrderDrafts } from "../numbered-order-drafts";
import type { OrderDraftItem } from "../numbered-order-drafts-core";
import { useSharedItemSelection } from "../shared-item-selection";
import { ItemReserveQuickEdit } from "../ItemReserveQuickEdit";
import { ItemPurchaseFactorQuickEdit } from "../ItemPurchaseFactorQuickEdit";
import { createTwoColumnItemNamesPdf, exportPdfToDevice } from "../item-names-pdf";
import { itemOptionsPresetFiltersSchema, type ItemOptionsPreset, type ItemOptionsPresetFilters } from "../../../../packages/contracts/src/item-options-presets.ts";

const ranges = [
  { key: "stockMin", label: "الكمية المتوفرة (بدون مخازن المرتجعات) من" },
  { key: "stockMax", label: "الكمية المتوفرة (بدون مخازن المرتجعات) إلى" },
  { key: "reserveMin", label: "الكمية احتياط من" },
  { key: "reserveMax", label: "الكمية احتياط إلى" },
  { key: "purchaseFactorMin", label: "عامل وحدة الشراء من" },
  { key: "purchaseFactorMax", label: "عامل وحدة الشراء إلى" },
  { key: "monthMin", label: "المبيعات مرات في شهر من" },
  { key: "monthMax", label: "المبيعات مرات في شهر إلى" },
  { key: "fourMonthsMin", label: "المبيعات مرات في 4 أشهر من" },
  { key: "fourMonthsMax", label: "المبيعات مرات في 4 أشهر إلى" },
  { key: "yearMin", label: "المبيعات مرات في عام من" },
  { key: "yearMax", label: "المبيعات مرات في عام إلى" },
  { key: "allTimeMin", label: "المبيعات مرات منذ البداية من" },
  { key: "allTimeMax", label: "المبيعات مرات منذ البداية إلى" },
  { key: "previousYearMin", label: "مرات عام السابق من" },
  { key: "previousYearMax", label: "مرات عام السابق إلى" },
  { key: "coverageMin", label: "الكفاية من (يوم)" },
  { key: "coverageMax", label: "الكفاية إلى (يوم)" },
  { key: "reserveCoverageMin", label: "كفاية الكمية الاحتياط من (يوم)" },
  { key: "reserveCoverageMax", label: "كفاية الكمية الاحتياط إلى (يوم)" },
  { key: "purchaseFactorCoverageMin", label: "كفاية عامل وحدة الشراء من (يوم)" },
  { key: "purchaseFactorCoverageMax", label: "كفاية عامل وحدة الشراء إلى (يوم)" },
] as const;
type RangeKey = (typeof ranges)[number]["key"];
type Draft = Record<RangeKey, string> & { excludeZero: boolean; excludeOrderStopped: boolean; excludeOrderDrafts: boolean; useReserve: boolean };
function readDraft(params: URLSearchParams): Draft {
  return {
    stockMin: params.get("stockMin") ?? "", stockMax: params.get("stockMax") ?? "",
    reserveMin: params.get("reserveMin") ?? "", reserveMax: params.get("reserveMax") ?? "",
    purchaseFactorMin: params.get("purchaseFactorMin") ?? "", purchaseFactorMax: params.get("purchaseFactorMax") ?? "",
    monthMin: params.get("monthMin") ?? "1", monthMax: params.get("monthMax") ?? "",
    fourMonthsMin: params.get("fourMonthsMin") ?? "", fourMonthsMax: params.get("fourMonthsMax") ?? "",
    yearMin: params.get("yearMin") ?? "2", yearMax: params.get("yearMax") ?? "",
    allTimeMin: params.get("allTimeMin") ?? "", allTimeMax: params.get("allTimeMax") ?? "",
    previousYearMin: params.get("previousYearMin") ?? "", previousYearMax: params.get("previousYearMax") ?? "",
    coverageMin: params.get("coverageMin") ?? "", coverageMax: params.get("coverageMax") ?? "1",
    reserveCoverageMin: params.get("reserveCoverageMin") ?? "", reserveCoverageMax: params.get("reserveCoverageMax") ?? "",
    purchaseFactorCoverageMin: params.get("purchaseFactorCoverageMin") ?? "", purchaseFactorCoverageMax: params.get("purchaseFactorCoverageMax") ?? "",
    excludeZero: params.get("excludeZero") === "true",
    excludeOrderStopped: params.get("excludeOrderStopped") !== "false",
    excludeOrderDrafts: params.get("excludeOrderDrafts") !== "false",
    useReserve: params.get("useReserve") !== "false",
  };
}
/** Preserve explicitly blank ranges, including user-cleared defaults. */
function appliedFilterParams(previous: URLSearchParams, values: Draft, query: string): URLSearchParams {
  const next = new URLSearchParams(previous);
  for (const { key } of ranges) {
    const value = values[key].trim();
    if (value || key === "stockMin" || key === "stockMax" ||
        key === "monthMin" || key === "yearMin" || key === "coverageMax")
      next.set(key, value);
    else next.delete(key);
  }
  if (query.trim()) next.set("q", query.trim()); else next.delete("q");
  if (values.excludeZero) next.set("excludeZero", "true"); else next.delete("excludeZero");
  if (!values.excludeOrderStopped) next.set("excludeOrderStopped", "false"); else next.delete("excludeOrderStopped");
  if (!values.excludeOrderDrafts) next.set("excludeOrderDrafts", "false"); else next.delete("excludeOrderDrafts");
  if (!values.useReserve) next.set("useReserve", "false"); else next.delete("useReserve");
  next.delete("page");
  return next;
}
type Row = {
  itemId: number; code: string; name: string; active: boolean;
  revision: number; reserveQuantity: string; purchaseFactor: number;
  requiredPurchaseQuantity: string;
  purchasePrice: string; purchaseCurrencyCode: string;
  requiredPurchaseValue: string; coverageWithRequiredDays: string;
  factor2: number; factor3: number; availableSmallest: string;
  availableUnit1: string; saleTimesMonth: string; saleQuantityMonth: string; saleTimesFourMonths: string; saleTimesYear: string;
  saleTimesAllTime: string; saleTimesPreviousYear: string;
  approximateCoverageDays: string | null;
  coverageAfterReserveDays: string | null;
  reserveCoverageDays: string | null;
  purchaseFactorCoverageDays: string | null;
};
type Response = {
  result: { rows: Row[]; total: number; page: number; pageSize: number; asOf: string;
    requiredPurchaseValueTotals: Array<{ currencyCode: string; value: string }> };
};
/** Group a PostgreSQL numeric string without losing large decimal precision. */
function formatAmountGroup(amount: string): string {
  const [whole, fraction = ""] = amount.split(".");
  const normalized = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = fraction.replace(/0+$/, "");
  return decimals ? `${normalized}.${decimals}` : normalized;
}
const sortOptions = [
  ["code", "رمز الصنف"], ["name", "اسم الصنف"],
  ["stock", "الكمية المتوفرة"], ["reserve", "الكمية احتياط"],
  ["purchaseFactor", "عامل وحدة الشراء"],
  ["month", "مرات المبيعات في شهر"], ["saleQuantityMonth", "الكمية المباعة في شهر"],
  ["fourMonths", "مرات المبيعات في 4 أشهر"], ["year", "مرات المبيعات في عام"], ["allTime", "مرات المبيعات منذ البداية"],
  ["previousYear", "مرات عام السابق"],
  ["requiredPurchaseQuantity", "الكمية المطلوبة"],
  ["purchasePrice", "سعر الشراء الافتراضي"],
  ["requiredPurchaseValue", "قيمة المطلوب"],
  ["coverageWithRequired", "الكفاية مع المطلوب"],
  ["coverage", "الكفاية"], ["reserveCoverage", "كفاية الكمية الاحتياط"],
  ["purchaseFactorCoverage", "كفاية عامل وحدة الشراء"],
] as const;
const tableColumnOptions = [["choice","اختيار"],["name","اسم الصنف"],["stock","المتوفر دون المرتجعات (الوحدة الأولى)"],["reserve","كمية احتياط"],["purchaseFactor","عامل وحدة الشراء"],["month","مبيعات مرات في شهر"],["saleQuantityMonth","الكمية المباعة في شهر (الوحدة الأولى)"],["fourMonths","مبيعات مرات في 4 أشهر"],["allTime","مبيعات مرات منذ البداية"],["previousYear","مرات عام السابق"],["requiredPurchaseQuantity","الكمية المطلوبة (الوحدة الأولى)"],["purchasePrice","سعر الشراء الافتراضي (الوحدة الأولى)"],["requiredPurchaseValue","قيمة المطلوب"],["coverage","الكفاية (يوم)"],["coverageWithRequired","الكفاية مع المطلوب (يوم)"],["reserveCoverage","كفاية الكمية الاحتياط (يوم)"],["purchaseFactorCoverage","كفاية عامل وحدة الشراء (يوم)"]] as const;
type TableColumn = (typeof tableColumnOptions)[number][0];
const allTableColumns = tableColumnOptions.map(([id]) => id);
function readVisibleTableColumns(key: string): TableColumn[] {
  if (typeof window === "undefined") return allTableColumns;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return allTableColumns;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return allTableColumns;
    const valid = allTableColumns.filter(id => parsed.includes(id));
    return valid.length ? valid : allTableColumns;
  } catch { return allTableColumns; }
}
export function ItemOptionsListPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const temporarySelection = useSharedItemSelection(companyId, user?.id);
  const temporaryOrder = useNumberedOrderDrafts(companyId, user?.id);
  const [optionsCollapsed, setOptionsCollapsed] = useState(false);
  const [activeOrderDraftId, setActiveOrderDraftId] = useState<number | null>(null);
  const [addingUnselected, setAddingUnselected] = useState(false);
  const [bulkAddError, setBulkAddError] = useState("");
  const [printMode, setPrintMode] = useState<"selected" | number>("selected");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const columnsStorageKey = `alraesy:item-options-columns:v1:${companyId}:${user?.id ?? "guest"}`;
  const [visibleColumns, setVisibleColumns] = useState<TableColumn[]>(() => readVisibleTableColumns(columnsStorageKey));
  const [editingColumns, setEditingColumns] = useState<TableColumn[]>(visibleColumns);
  const [columnsDialogOpen, setColumnsDialogOpen] = useState(false);
  const directory = usePageDirectory(companyId);
  const itemListPage = directory.data?.find(row => row.key === "company.item-options-list");
  const canView = !!itemListPage?.enabled && !!itemListPage.actionAccess.view;
  const canEditReserve = !!itemListPage?.enabled && !!itemListPage.actionAccess.edit;
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Draft>(() => readDraft(params));
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [filterError, setFilterError] = useState("");
  const applyingFilterRef = useRef(false);
  const [applyingFilter, setApplyingFilter] = useState(false);
  const [autoFilterPending, setAutoFilterPending] = useState(false);
  const autoFilterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoFilterSequence = useRef(0);
  const queuedFilterApplication = useRef<(() => void) | null>(null);
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
  useEffect(() => {
    const next = readVisibleTableColumns(columnsStorageKey);
    setVisibleColumns(next);
    setEditingColumns(next);
    setColumnsDialogOpen(false);
  }, [columnsStorageKey]);
  const hiddenColumnStyle = (column: string) =>
    visibleColumns.includes(column as TableColumn) ? undefined : { display: "none" as const };
  const openColumnsDialog = () => {
    setEditingColumns([...visibleColumns]);
    setColumnsDialogOpen(true);
  };
  const applyColumns = () => {
    if (!editingColumns.length) return;
    setVisibleColumns(editingColumns);
    try { window.localStorage.setItem(columnsStorageKey, JSON.stringify(editingColumns)); }
    catch { /* Private mode may disable local storage. */ }
    setColumnsDialogOpen(false);
  };

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
    // Absent parameters get defaults; an explicitly blank value remains unbounded.
    const value = (params.get(key) ??
      (key === "monthMin" || key === "coverageMax" ? "1" : key === "yearMin" ? "2" : "")).trim();
    if (value && numberPattern.test(value)) request.set(key, value);
  }
  if (params.get("excludeZero") === "true") request.set("excludeZero", "true");
  if (params.get("excludeOrderStopped") === "false") request.set("excludeOrderStopped", "false");
  if (params.get("excludeOrderDrafts") === "false") request.set("excludeOrderDrafts", "false");
  if (params.get("useReserve") === "false") request.set("useReserve", "false");
  // The numbered drafts are intentionally device-local. Pass only their IDs,
  // so PostgreSQL filters ALL matching items before count, value totals, sort
  // and pagination. A POST avoids URL-length limits for larger saved drafts.
  const excludedDraftItemIds = params.get("excludeOrderDrafts") === "false" ? []
    : Array.from(new Set(temporaryOrder.drafts.flatMap(orderDraft =>
      orderDraft.items.map(item => item.id)))).sort((a, b) => a - b);
  const draftExclusionKey = excludedDraftItemIds.join(",");
  const resultQuery = useQuery({
    queryKey: ["item-options-list", user?.id, companyId, request.toString(), draftExclusionKey],
    queryFn: ({ signal }) => api<Response>(
      `/companies/${companyId}/item-options-list/query?${request.toString()}`,
      { method: "POST", body: { excludedItemIds: excludedDraftItemIds }, signal }),
    enabled: !!user && canView,
    staleTime: 0,
  });
  const result = resultQuery.data?.result;
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / pageSize));
  const selectedIds = new Set(temporarySelection.items.map(row => row.id));
  const draftItems = (draftId: number) =>
    temporaryOrder.drafts.find(draft => draft.id === draftId)?.items ?? [];
  const printItems = printMode === "selected" ? temporarySelection.items : draftItems(printMode);
  const savedRequiredQuantity = (item: TemporaryChosenItem | OrderDraftItem): string =>
    "requiredQuantity" in item && typeof item.requiredQuantity === "string"
      ? item.requiredQuantity : "—";
  function printSelection(mode: "selected" | number) {
    const list = mode === "selected" ? temporarySelection.items : draftItems(mode);
    if (!list.length) return;
    flushSync(() => setPrintMode(mode));
    window.print();
  }
  async function exportSelectionPdf(mode: "selected" | number) {
    if (exportingPdf) return;
    const list = mode === "selected" ? temporarySelection.items : draftItems(mode);
    if (!list.length) return;
    setExportingPdf(true);
    setActionMessage("");
    try {
      // Real PDF bytes, not the browser's print-to-PDF dialog; Arabic lettering
      // is shaped by the device and each A4 page has exactly two columns.
      const pdf = createTwoColumnItemNamesPdf(mode === "selected"
        ? list.map(item => item.name)
        : list.map(item => ({
            name: item.name,
            requiredQuantity: savedRequiredQuantity(item),
          })));
      const today = new Date().toLocaleDateString("en-CA");
      const filename = `${mode === "selected" ? "selected-items" : `item-order-draft-${mode}`}-${today}.pdf`;
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
  // Reverse of the company-wide temporary checkmarks: collect every matching
  // UNSELECTED item, not just the 50 visible on the current page.
  async function addUnselectedToOrderDraft() {
    if (!canView || !result || addingUnselected || resultQuery.isFetching ||
        temporarySelection.updating || applyingFilter || autoFilterPending) return;
    setAddingUnselected(true);
    setBulkAddError("");
    setActionMessage("");
    try {
      const filters = new URLSearchParams(request);
      filters.delete("page");
      filters.delete("pageSize");
      const response = await api<{ result: { items: OrderDraftItem[]; total: number } }>(
        `/companies/${companyId}/item-options-list/unselected/query?${filters.toString()}`,
        { method: "POST", body: { excludedItemIds: excludedDraftItemIds } },
      );
      const candidates = response.result.items;
      if (!candidates.length) {
        setActionMessage("لا توجد أصناف غير مختارة خارج مسودات الطلبيات الحالية تطابق الخيارات.");
        return;
      }
      // Each transfer creates a new numbered draft only for items not already
      // present in ANY draft. If all incoming items are duplicates, do not
      // make an empty draft or change an existing draft.
      const created = temporaryOrder.createDraft(candidates);
      if (!created) return;
      if (created.id === null) {
        setActionMessage("جميع الأصناف غير المختارة المطابقة موجودة بالفعل في مسودات أخرى؛ لم تُنشأ مسودة فارغة ولم يُكرر أي صنف.");
        return;
      }
      setActiveOrderDraftId(created.added <= 100 ? created.id : null);
      setActionMessage(
        `تم إنشاء مسودة الطلبية ${created.id} بعدد ${created.added.toLocaleString("en-US")} صنف جديد` +
        (created.skipped ? `؛ جرى تجاهل ${created.skipped.toLocaleString("en-US")} صنف مكرر موجود في مسودات سابقة.`
          : " دون أي تكرار.") +
        " لا تُنشأ طلبية شراء رسمية.",
      );
    } catch (reason) {
      setBulkAddError(`تعذر إضافة جميع الأصناف غير المختارة: ${errorMessage(reason)}`);
    } finally {
      setAddingUnselected(false);
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
  // Debounce typing; only committed changes clear company-wide selection.
  function cancelAutoFilter() {
    autoFilterSequence.current += 1;
    if (autoFilterTimer.current !== null) clearTimeout(autoFilterTimer.current);
    autoFilterTimer.current = null;
    setAutoFilterPending(false);
  }
  useEffect(() => () => {
    if (autoFilterTimer.current !== null) clearTimeout(autoFilterTimer.current);
  }, []);
  function scheduleAutoFilter(values: Draft, nextSearch: string) {
    const sequence = ++autoFilterSequence.current;
    if (autoFilterTimer.current !== null) clearTimeout(autoFilterTimer.current);
    setAutoFilterPending(true);
    setSelectedPresetId("");
    autoFilterTimer.current = setTimeout(() => {
      autoFilterTimer.current = null;
      const invalid = ranges.find(({ key }) =>
        values[key].trim() && !numberPattern.test(values[key].trim()));
      if (invalid) {
        setFilterError(`حقل «${invalid.label}» غير صالح. أدخل رقمًا أو اتركه فارغًا.`);
        if (sequence === autoFilterSequence.current) setAutoFilterPending(false);
        return;
      }
      void runFilterApplication(() => setParams(previous =>
        appliedFilterParams(previous, values, nextSearch))).finally(() => {
        if (sequence === autoFilterSequence.current) setAutoFilterPending(false);
      });
    }, 500);
  }
  // Both ad-hoc and named filters start a new company-wide selection round.
  // Keep deletion on the existing edit-authorized API; read-only employees may
  // still browse filters, but cannot modify the shared selection.
  async function runFilterApplication(applyFilters: () => void) {
    if (!canView) return;
    if (applyingFilterRef.current) {
      queuedFilterApplication.current = applyFilters;
      return;
    }
    if (temporarySelection.updating) {
      setFilterError("يوجد اختيار مؤقت قيد الحفظ. أعد تطبيق الفلتر بعد اكتماله.");
      return;
    }
    applyingFilterRef.current = true;
    setApplyingFilter(true);
    try {
      // Always clear in PostgreSQL even if this device currently shows zero:
      // another employee could have selected items since our last refresh.
      if (canEditReserve && !(await temporarySelection.clear())) {
        setFilterError("تعذر تصفير الاختيارات المشتركة؛ لم يُطبَّق الفلتر. حاول مجددًا.");
        return;
      }
      setFilterError("");
      setActionMessage("");
      applyFilters();
    } catch (cause) {
      setFilterError(`تعذر تطبيق الفلتر وتصفير المختار: ${errorMessage(cause)}`);
    } finally {
      applyingFilterRef.current = false;
      setApplyingFilter(false);
      const queued = queuedFilterApplication.current;
      queuedFilterApplication.current = null;
      if (queued) void runFilterApplication(queued);
    }
  }
  // Save draft controls, including un-applied range edits, but not page number.
  function currentPresetFilters(): ItemOptionsPresetFilters | null {
    const candidate = {
      q: search.trim(), active, sortBy, sortDir,
      ...Object.fromEntries(ranges.map(({key}) => [key,draft[key].trim()])),
      excludeZero: draft.excludeZero,
      excludeOrderStopped: draft.excludeOrderStopped,
      excludeOrderDrafts: draft.excludeOrderDrafts,
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
    void runFilterApplication(() => {
    const next = new URLSearchParams();
    next.set("active",values.active);
    next.set("sortBy",values.sortBy);
    next.set("sortDir",values.sortDir);
    next.set("pageSize",String(pageSize));
    if(values.q) next.set("q",values.q);
    for(const {key} of ranges) next.set(key,values[key]);
    if(values.excludeZero) next.set("excludeZero","true");
    if(!values.excludeOrderStopped) next.set("excludeOrderStopped","false");
    if(!values.excludeOrderDrafts) next.set("excludeOrderDrafts","false");
    if(!values.useReserve) next.set("useReserve","false");
    setDraft(readDraft(next));
    setSearch(values.q);
    setFilterError("");
    setPresetMessage(null);
    setOptionsCollapsed(false);
    setParams(next);
    });
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
    cancelAutoFilter();
    setSelectedPresetId("");
    const defaults = new URLSearchParams({
      monthMin: "1", yearMin: "2", coverageMax: "1",
      sortBy: "allTime", sortDir: "desc",
    });
    void runFilterApplication(() => {
      setFilterError("");
      setDraft(readDraft(defaults));
      setSearch("");
      setParams(defaults);
    });
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
    return <th key={column} style={hiddenColumnStyle(column)} aria-sort={selected
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
      description="تصفية الأصناف حسب المتوفر والاحتياطي ومرات المبيعات والسنة السابقة والكفاية — دون احتساب مخازن المرتجعات"
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
    {bulkAddError && <Notice tone="error">{bulkAddError}</Notice>}
    {!optionsCollapsed && <Card title="خيارات قائمة الأصناف" className="item-options-filters-card">
      <form onSubmit={event => event.preventDefault()}>
        <div className="item-options-filter-scroll" role="region"
          aria-label="مرر لعرض جميع خيارات تصفية الأصناف" tabIndex={0}>
          <div className="item-options-filter-grid">
            <label className="item-options-filter-field">
              <span className="item-options-filter-label">بحث عن صنف بالاسم أو الرمز أو الباركود</span>
              <input type="search" maxLength={120} value={search}
                placeholder="اكتب الاسم أو الرمز" onChange={event => {
                   setSearch(event.target.value);
                   scheduleAutoFilter(draft, event.target.value);
                 }} />
            </label>
            <label className="item-options-filter-field">
              <span className="item-options-filter-label">حالة الصنف</span>
              <select value={active} onChange={event => {
                   cancelAutoFilter();
                   void runFilterApplication(() => change("active", event.target.value));
                 }}>
                <option value="active">الفعال</option>
                <option value="archived">المؤرشف</option>
                <option value="all">الكل</option>
              </select>
            </label>
            {ranges.map(({ key, label }) =>
              <label className="item-options-filter-field" key={key}>
                <span className="item-options-filter-label" title={label}>{label}</span>
                <input type="text" inputMode="decimal"
                  value={draft[key]}
                  onChange={event => {
                     const next = { ...draft, [key]: event.target.value };
                     setDraft(next); scheduleAutoFilter(next, search);
                   }} />
              </label>
            )}
          </div>
        </div>
        <div className="form-actions item-options-filter-actions">
          <label className="checkbox">
            <input type="checkbox" checked={draft.excludeZero}
              onChange={event => {
                 const next = { ...draft, excludeZero: event.target.checked };
                 setDraft(next); scheduleAutoFilter(next, search);
               }} />
            استثناء الأصناف ذات الكمية الصفرية
          </label>
          <label className="checkbox" title="عند التفعيل تُستبعد الأصناف التي يكون تاريخ «يتوقف الطلب حتى تاريخ» في كرت الصنف بعد تاريخ اليوم، فلا تدخل في قائمة الطلب أو الإجمالي أو المسودات.">
            <input type="checkbox" checked={draft.excludeOrderStopped}
              onChange={event => {
                 const next = { ...draft, excludeOrderStopped: event.target.checked };
                 setDraft(next); scheduleAutoFilter(next, search);
               }} />
            إيقاف طلب الأصناف الموقوفة حتى تاريخ مستقبلي
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.useReserve}
              onChange={event => {
                 const next = { ...draft, useReserve: event.target.checked };
                 setDraft(next); scheduleAutoFilter(next, search);
               }} />
            استخدام الكفاية مع الاحتياطي
          </label>
          <label className="checkbox" title="استبعاد الأصناف الموجودة في أي مسودة طلبية على هذا الجهاز من نتائج القائمة وإجمالي المطلوب والترحيل إلى مسودة جديدة.">
            <input type="checkbox" checked={draft.excludeOrderDrafts}
              onChange={event => {
                 const next = { ...draft, excludeOrderDrafts: event.target.checked };
                 setDraft(next); scheduleAutoFilter(next, search);
               }} />
            استثناء الأصناف المرحّلة إلى مسودات الطلبيات
          </label>
          
          <Button type="button" variant="secondary" onClick={reset}>إعادة الافتراضيات</Button>
        </div>
      </form>
    </Card>}
    {canEditReserve && <p className="muted">تُطبّق الخيارات تلقائيًا بعد التعديل، ويُصفَّر الاختيار المؤقت المشترك عند اعتماد الفلتر، دون حذف مسودات الطلبيات.</p>}
    {canView && <Card title="الفلاتر المحفوظة للجميع" className="item-options-presets-card">
      <p className="muted">أي موظف يستطيع حفظ مجموعة فلاتر باسم، ويستطيع جميع مستخدمي الشركة استدعاءها من أي جهاز. الحذف متاح لمن لديه صلاحية تعديل الصفحة.</p>
      <div className="form-actions">
        <label className="item-options-filter-field item-options-preset-field">
          <span className="item-options-filter-label">الفلاتر المشتركة المحفوظة</span>
          <select aria-label="الفلاتر المشتركة المحفوظة" value={selectedPresetId}
            onChange={event => {
               const id = event.target.value;
               setSelectedPresetId(id);
               const choice = presets.find(preset => String(preset.id) === id);
               if (choice) { cancelAutoFilter(); applyPreset(choice); }
             }}>
            <option value="">اختر فلترًا محفوظًا</option>
            {presets.map(preset=><option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
        
        {canDeletePresets && <Button type="button" variant="danger" disabled={!selectedPreset || presetBusy}
          onClick={()=>{if(selectedPreset) void deletePreset(selectedPreset);}}>
          حذف الفلتر
        </Button>}
        <Button type="button" variant="secondary" disabled={presetsQuery.isFetching}
          onClick={()=>void presetsQuery.refetch()}>تحديث الفلاتر</Button>
      </div>
      {selectedPreset && <small className="muted">أضافه: {selectedPreset.createdByName}</small>}
      <form className="form-actions" onSubmit={event=>{event.preventDefault();void savePreset();}}>
        <label className="item-options-filter-field item-options-preset-field">
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
    <Card title={`مسودات الطلبيات (${temporaryOrder.drafts.length})`}
      className="item-options-drafts-card">
      <div className="item-options-order-draft">
        <p className="muted">مسودات الطلبيات محفوظة على هذا الجهاز فقط، وتُحذف كل مسودة تلقائيًا بعد 8 ساعات من إنشائها. كل ترحيل ناجح ينشئ مسودة جديدة، ولا يتكرر الصنف في أي مسودتين.</p>
        {!temporaryOrder.drafts.length && <p>لا توجد مسودات طلبية بعد.</p>}
        {temporaryOrder.drafts.map(orderDraft => <div key={orderDraft.id} className="item-options-order-draft-group">
          <div className="form-actions item-options-order-draft-actions">
            <div className="item-options-order-draft-meta">
              <strong>مسودة الطلبية {orderDraft.id} ({orderDraft.items.length.toLocaleString("en-US")} صنف)</strong>
              <small className="muted" title="تنتهي المسودة بعد 8 ساعات من إنشائها">أُنشئت: {new Date(orderDraft.createdAt).toLocaleString("ar-YE")}</small>
            </div>
            <div className="item-options-order-draft-buttons">
            <Button size="compact" variant="secondary"
              onClick={() => setActiveOrderDraftId(current =>
                current === orderDraft.id ? null : orderDraft.id)}>
              {activeOrderDraftId === orderDraft.id ? "إخفاء الأصناف" : "عرض الأصناف"}
            </Button>
            <Button size="compact" variant="secondary" disabled={!orderDraft.items.length}
              onClick={() => printSelection(orderDraft.id)}>طباعة</Button>
            <Button size="compact" variant="secondary"
              disabled={exportingPdf || !orderDraft.items.length}
              onClick={() => void exportSelectionPdf(orderDraft.id)}>
              {exportingPdf ? "جارٍ تجهيز PDF…" : "تصدير PDF"}
            </Button>
            <Button size="compact" variant="danger"
              onClick={() => {
                if (!window.confirm(`هل تريد حذف مسودة الطلبية ${orderDraft.id} بكل أصنافها (${orderDraft.items.length}) من هذا الجهاز؟ لن تُحذف المسودات الأخرى.`))
                  return;
                if (temporaryOrder.deleteDraft(orderDraft.id)) {
                  if (activeOrderDraftId === orderDraft.id) setActiveOrderDraftId(null);
                  setActionMessage(`حُذفت مسودة الطلبية ${orderDraft.id} فقط. أصبح بالإمكان ترحيل أصنافها في مسودة جديدة.`);
                }
              }}>حذف المسودة</Button>
            </div>
          </div>
          {activeOrderDraftId === orderDraft.id && <div className="item-options-order-draft-lines">
            {orderDraft.items.map(item => <div key={item.id} className="item-options-order-row">
              <span className="item-options-order-item">
                <bdi className="item-options-order-quantity">{item.requiredQuantity ?? "—"}</bdi>
                <span>{item.name}</span>
              </span>
              <Button size="compact" variant="ghost"
                onClick={() => temporaryOrder.removeItem(orderDraft.id, item.id)}>إزالة</Button>
            </div>)}
            {!orderDraft.items.length && <p>هذه المسودة فارغة.</p>}
          </div>}
        </div>)}
      </div>
    </Card>
    <Card title="نتائج قائمة الأصناف">
      <div className="item-options-selection-tools">
        <span>الاختيار المؤقت المشترك للشركة: <strong>{temporarySelection.items.length.toLocaleString("en-US")}</strong> صنف</span>
        <Button variant="secondary"
          disabled={!canView || !result || !result.total || addingUnselected ||
            resultQuery.isFetching || applyingFilter || autoFilterPending || temporarySelection.updating || !temporaryOrder.enabled}
          onClick={() => void addUnselectedToOrderDraft()}>
          {addingUnselected ? "جارٍ إضافة كل غير المختارة…" : "إضافة جميع الأصناف غير المختارة إلى مسودة طلبية"}
        </Button>
      </div>
      {result && <p className="muted">
        إجمالي الأصناف المطابقة: <bdi>{result.total.toLocaleString("en-US")}</bdi>
        {" "}· إجمالي قيمة المطلوب:{" "}
        {result.requiredPurchaseValueTotals.length ?
          result.requiredPurchaseValueTotals.map((entry, index) =>
            <span key={entry.currencyCode}>
              {index > 0 ? " ؛ " : ""}
              <bdi>{formatAmountGroup(entry.value)} {entry.currencyCode}</bdi>
            </span>) : <bdi>0</bdi>}
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
        <Button type="button" variant="secondary" onClick={openColumnsDialog}>
          الأعمدة ({visibleColumns.length}/{tableColumnOptions.length})
        </Button>
        <Select label="الأصناف في الصفحة" value={String(pageSize)}
          onChange={event => change("pageSize", event.target.value)}>
          <option value="20">20</option><option value="50">50</option><option value="100">100</option>
        </Select>
      </div>
      {columnsDialogOpen && <div role="presentation" style={{
        position: "fixed", inset: 0, zIndex: 1200, display: "flex",
        alignItems: "center", justifyContent: "center", padding: 12,
        background: "rgba(0, 0, 0, 0.6)"
      }} onMouseDown={event => {
        if (event.target === event.currentTarget) setColumnsDialogOpen(false);
      }}>
        <div role="dialog" aria-modal="true" aria-labelledby="item-options-columns-heading"
          onKeyDown={event => { if (event.key === "Escape") setColumnsDialogOpen(false); }}
          style={{
            background: "var(--surface)",
            color: "inherit", border: "1px solid var(--border, #506070)",
            borderRadius: 12, padding: 16, width: "min(480px, 100%)",
            maxHeight: "min(85vh, 740px)", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.3)"
          }}>
          <h3 id="item-options-columns-heading" style={{ marginTop: 0 }}>الأعمدة الظاهرة</h3>
          <p className="muted">ضع علامة صح على الأعمدة المطلوبة ثم اضغط «موافق». تُحفظ اختياراتك على هذا الجهاز.</p>
          <div style={{ display: "grid", gap: 10, marginBlock: 16 }}>
            {tableColumnOptions.map(([key, label]) => <label key={key}
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={editingColumns.includes(key)}
                onChange={event => setEditingColumns(previous =>
                  event.target.checked ? [...previous, key] : previous.filter(id => id !== key))} />
              <span>{label}</span>
            </label>)}
          </div>
          {!editingColumns.length && <Notice tone="warning">اختر عمودًا واحدًا على الأقل.</Notice>}
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setEditingColumns([...allTableColumns])}>إظهار الكل</Button>
            <Button variant="secondary" onClick={() => setColumnsDialogOpen(false)}>إلغاء</Button>
            <Button disabled={!editingColumns.length} onClick={applyColumns}>موافق</Button>
          </div>
        </div>
      </div>}
      {resultQuery.isPending && canView && <Notice>جارٍ تحميل الأصناف المطابقة…</Notice>}
      {result && <>
        <div className="item-options-mobile-list" role="list" aria-label="قائمة الأصناف للهاتف">
          {result.rows.map(row => <article key={row.itemId} className={`item-options-mobile-entry${selectedIds.has(row.itemId) ? " item-options-chosen-row" : ""}`}
            role="listitem" onClick={() => rememberItem(row)}>
            <div className="item-options-mobile-heading">
              <Link style={hiddenColumnStyle("name")} to={`/companies/${companyId}/items/${row.itemId}`}>{row.name}</Link>
              {!row.active && <span style={hiddenColumnStyle("name")} className="item-options-mobile-inactive"> (مؤرشف)</span>}
              <label className="item-options-mobile-select" style={hiddenColumnStyle("choice")}>
                <input type="checkbox" aria-label={`اختيار الصنف ${row.name}`}
                  checked={selectedIds.has(row.itemId)}
                  disabled={!temporarySelection.enabled || temporarySelection.pendingIds.has(row.itemId)}
                  onChange={event => void temporarySelection.toggle(
                    { id: row.itemId, name: row.name, code: row.code }, event.target.checked)} />
              </label>
            </div>
            <div className="item-options-mobile-stats" aria-label="المتوفر ومرات البيع والكفاية">
              <div style={hiddenColumnStyle("stock")} className="item-options-mobile-stat">
                <span>المتوفر</span><bdi>{firstUnitStockText(row.availableSmallest, row)}</bdi>
              </div>
              <div style={hiddenColumnStyle("reserve")} className="item-options-mobile-stat item-options-reserve-stat">
                <span>كمية احتياط</span>
                <ItemReserveQuickEdit key={row.itemId} companyId={companyId} itemId={row.itemId}
                  revision={row.revision} reserveQuantity={row.reserveQuantity}
                  canEdit={canEditReserve} />
              </div>
              <div style={hiddenColumnStyle("purchaseFactor")} className="item-options-mobile-stat item-options-reserve-stat">
                <span>عامل وحدة الشراء</span>
                <ItemPurchaseFactorQuickEdit key={row.itemId} companyId={companyId} itemId={row.itemId}
                  revision={row.revision} purchaseFactor={row.purchaseFactor}
                  canEdit={canEditReserve} />
              </div>
              <div style={hiddenColumnStyle("month")} className="item-options-mobile-stat">
                <span>شهر</span><bdi>{row.saleTimesMonth}</bdi>
              </div>
              <div style={hiddenColumnStyle("saleQuantityMonth")} className="item-options-mobile-stat">
                <span>كمية مباعة في شهر (الوحدة الأولى)</span><bdi>{row.saleQuantityMonth}</bdi>
              </div>
              <div style={hiddenColumnStyle("fourMonths")} className="item-options-mobile-stat">
                <span>4 أشهر</span><bdi>{row.saleTimesFourMonths}</bdi>
              </div>
              <div style={hiddenColumnStyle("allTime")} className="item-options-mobile-stat">
                <span>منذ البداية</span><bdi>{row.saleTimesAllTime}</bdi>
              </div>
              <div style={hiddenColumnStyle("previousYear")} className="item-options-mobile-stat">
                <span>مرات عام السابق</span><bdi>{row.saleTimesPreviousYear}</bdi>
              </div>
              <div style={hiddenColumnStyle("requiredPurchaseQuantity")} className="item-options-mobile-stat">
                <span>الكمية المطلوبة (الوحدة الأولى)</span><bdi>{row.requiredPurchaseQuantity}</bdi>
              </div>
              <div style={hiddenColumnStyle("purchasePrice")} className="item-options-mobile-stat">
                <span>سعر الشراء الافتراضي (الوحدة الأولى)</span><bdi>{row.purchasePrice} {row.purchaseCurrencyCode}</bdi>
              </div>
              <div style={hiddenColumnStyle("requiredPurchaseValue")} className="item-options-mobile-stat">
                <span>قيمة المطلوب</span><bdi>{row.requiredPurchaseValue} {row.purchaseCurrencyCode}</bdi>
              </div>
              <div style={hiddenColumnStyle("coverage")} className="item-options-mobile-stat">
                <span>الكفاية/يوم</span><bdi>{coverage(row) ?? "—"}</bdi>
              </div>
              <div style={hiddenColumnStyle("coverageWithRequired")} className="item-options-mobile-stat">
                <span>الكفاية مع المطلوب/يوم</span><bdi>{row.coverageWithRequiredDays}</bdi>
              </div>
              <div style={hiddenColumnStyle("reserveCoverage")} className="item-options-mobile-stat">
                <span>كفاية الاحتياط/يوم</span><bdi>{row.reserveCoverageDays ?? "—"}</bdi>
              </div>
              <div style={hiddenColumnStyle("purchaseFactorCoverage")} className="item-options-mobile-stat">
                <span>كفاية عامل الشراء/يوم</span><bdi>{row.purchaseFactorCoverageDays ?? "—"}</bdi>
              </div>
            </div>
          </article>)}
          {!result.rows.length && <p className="muted">لا توجد أصناف تطابق الخيارات الحالية.</p>}
        </div>
        <div className={`table-scroll item-options-desktop-table${visibleColumns.length < allTableColumns.length ? " item-options-fit-columns" : ""}`} role="region"
          aria-label="نتائج الأصناف حسب الخيارات">
        <table style={visibleColumns.length < allTableColumns.length ? { minWidth: 0, width: "100%" } : undefined}>
          <colgroup>
            {visibleColumns.includes("choice") && <col className="item-options-choice-col" />}
            {visibleColumns.includes("name") && <col className="item-options-name-col" />}
            {visibleColumns.includes("stock") && <col className="item-options-stock-col" />}
            {visibleColumns.includes("reserve") && <col className="item-options-reserve-col" />}
            {visibleColumns.includes("purchaseFactor") && <col className="item-options-purchase-factor-col" />}
            {visibleColumns.includes("month") && <col className="item-options-month-times-col" />}
            {visibleColumns.includes("saleQuantityMonth") && <col className="item-options-month-quantity-col" />}
            {visibleColumns.includes("fourMonths") && <col className="item-options-four-months-col" />}
            {visibleColumns.includes("allTime") && <col className="item-options-all-time-col" />}
            {visibleColumns.includes("previousYear") && <col className="item-options-previous-year-col" />}
            {visibleColumns.includes("requiredPurchaseQuantity") && <col className="item-options-required-quantity-col" />}
            {visibleColumns.includes("purchasePrice") && <col className="item-options-purchase-price-col" />}
            {visibleColumns.includes("requiredPurchaseValue") && <col className="item-options-required-value-col" />}
            {visibleColumns.includes("coverage") && <col className="item-options-coverage-col" />}
            {visibleColumns.includes("coverageWithRequired") && <col className="item-options-coverage-with-required-col" />}
            {visibleColumns.includes("reserveCoverage") && <col className="item-options-reserve-coverage-col" />}
            {visibleColumns.includes("purchaseFactorCoverage") && <col className="item-options-factor-coverage-col" />}
          </colgroup>
          <thead><tr>
            <th scope="col" className="item-options-choice-cell" style={hiddenColumnStyle("choice")}>اختيار</th>
            {sortHeader("name", "اسم الصنف")}
            {sortHeader("stock", "المتوفر دون المرتجعات (الوحدة الأولى)")}
            {sortHeader("reserve", "كمية احتياط")}
            {sortHeader("purchaseFactor", "عامل وحدة الشراء")}
            {sortHeader("month", "مبيعات مرات في شهر")}
            {sortHeader("saleQuantityMonth", "الكمية المباعة في شهر (الوحدة الأولى)")}
            {sortHeader("fourMonths", "مبيعات مرات في 4 أشهر")}
            {sortHeader("allTime", "مبيعات مرات منذ البداية")}
            {sortHeader("previousYear", "مرات عام السابق")}
            {sortHeader("requiredPurchaseQuantity", "الكمية المطلوبة (الوحدة الأولى)")}
            {sortHeader("purchasePrice", "سعر الشراء الافتراضي (الوحدة الأولى)")}
            {sortHeader("requiredPurchaseValue", "قيمة المطلوب")}
            {sortHeader("coverage", "الكفاية (يوم)")}
            {sortHeader("coverageWithRequired", "الكفاية مع المطلوب (يوم)")}
            {sortHeader("reserveCoverage", "كفاية الكمية الاحتياط (يوم)")}
            {sortHeader("purchaseFactorCoverage", "كفاية عامل وحدة الشراء (يوم)")}
          </tr></thead>
          <tbody>
            {result.rows.map(row => <tr key={row.itemId}
              className={selectedIds.has(row.itemId) ? "item-options-chosen-row" : undefined}
              onClick={() => rememberItem(row)}>
              <td style={hiddenColumnStyle("choice")} className="item-options-choice-cell"><label className="item-options-table-choice">
                <input type="checkbox" aria-label={`اختيار الصنف ${row.name}`}
                  checked={selectedIds.has(row.itemId)}
                  disabled={!temporarySelection.enabled || temporarySelection.pendingIds.has(row.itemId)}
                  onChange={event => void temporarySelection.toggle(
                    { id: row.itemId, name: row.name, code: row.code }, event.target.checked)} />
              </label></td>
              <td style={hiddenColumnStyle("name")}><Link to={`/companies/${companyId}/items/${row.itemId}`}>{row.name}</Link>{!row.active && " (مؤرشف)"}</td>
              <td style={hiddenColumnStyle("stock")}><bdi>{firstUnitStockText(row.availableSmallest, row)}</bdi></td>
              <td style={hiddenColumnStyle("reserve")}><ItemReserveQuickEdit key={row.itemId} companyId={companyId}
                itemId={row.itemId} revision={row.revision}
                reserveQuantity={row.reserveQuantity} canEdit={canEditReserve} /></td>
               <td style={hiddenColumnStyle("purchaseFactor")}><ItemPurchaseFactorQuickEdit key={row.itemId} companyId={companyId}
                 itemId={row.itemId} revision={row.revision}
                 purchaseFactor={row.purchaseFactor} canEdit={canEditReserve} /></td>
              <td style={hiddenColumnStyle("month")}><bdi>{row.saleTimesMonth}</bdi></td>
              <td style={hiddenColumnStyle("saleQuantityMonth")}><bdi>{row.saleQuantityMonth}</bdi></td>
              <td style={hiddenColumnStyle("fourMonths")}><bdi>{row.saleTimesFourMonths}</bdi></td>
              <td style={hiddenColumnStyle("allTime")}><bdi>{row.saleTimesAllTime}</bdi></td>
              <td style={hiddenColumnStyle("previousYear")}><bdi>{row.saleTimesPreviousYear ?? "—"}</bdi></td>
              <td style={hiddenColumnStyle("requiredPurchaseQuantity")}><bdi>{row.requiredPurchaseQuantity}</bdi></td>
              <td style={hiddenColumnStyle("purchasePrice")}><bdi>{row.purchasePrice}</bdi><small className="item-options-currency">{row.purchaseCurrencyCode}</small></td>
              <td style={hiddenColumnStyle("requiredPurchaseValue")}><bdi>{row.requiredPurchaseValue}</bdi><small className="item-options-currency">{row.purchaseCurrencyCode}</small></td>
              <td style={hiddenColumnStyle("coverage")}><bdi>{coverage(row) ?? "—"}</bdi></td>
              <td style={hiddenColumnStyle("coverageWithRequired")}><bdi>{row.coverageWithRequiredDays}</bdi></td>
               <td style={hiddenColumnStyle("reserveCoverage")}><bdi>{row.reserveCoverageDays ?? "—"}</bdi></td>
               <td style={hiddenColumnStyle("purchaseFactorCoverage")}><bdi>{row.purchaseFactorCoverageDays ?? "—"}</bdi></td>
            </tr>)}
            {!result.rows.length && <tr><td colSpan={visibleColumns.length}>لا توجد أصناف تطابق الخيارات الحالية.</td></tr>}
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
        الكمية المطلوبة بالوحدة الأولى محسوبة للوصول إلى «الكفاية إلى» (أو 30 يومًا إن تُركت فارغة)،
         وتشمل الاحتياط عند اختياره، وتُقرّب لأقرب كمية كاملة بالوحدة الأولى توافق مضاعفات عامل وحدة الشراء. وأقل كمية مطلوبة هي دفعة شراء واحدة، ولا تظهر صفرًا.
         قيمة المطلوب = الكمية المطلوبة بالوحدة الأولى × سعر الشراء الافتراضي للوحدة الأولى، وبعملة الصنف.
         «الكفاية مع المطلوب» هي الكفاية المتوقعة بعد إضافة هذه الكمية إلى المخزون.
         كفاية الاحتياط وعامل الشراء مؤشران للتخطيط فقط؛ لا يضيفان مخزونًا أو يغيران الفواتير.
      </small>
    </Card>
    <section className="item-options-print-sheet" dir="rtl" aria-label="طباعة أصناف المسودة مع الكمية المطلوبة بالوحدة الأولى">
      <div className="item-options-print-columns">
        {printItems.map(item => <div className="item-options-print-row" key={item.id}>
          {printMode !== "selected" &&
            <bdi className="item-options-print-quantity">{
              savedRequiredQuantity(item)
            }</bdi>}
          <span className="item-options-print-name">{item.name}</span>
        </div>)}
      </div>
    </section>
  </div>;
}
