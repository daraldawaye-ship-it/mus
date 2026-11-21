import InteractiveColumnsTable,{type InteractiveTableColumn} from "../InteractiveColumnsTable";
import { formatNumber, formatStockSaleQuantity } from "../order-draft-quantities";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";
import { useQueries, useQuery,useQueryClient } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import type { ItemOptionsPresetGroup } from "../../../../packages/contracts/src/item-options-presets.ts";
import { normalizeDigits } from "../../../../packages/contracts/src/masters.ts";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { useNumberedOrderDrafts } from "../numbered-order-drafts";
import { usePageDirectory } from "../page-directory";
import { OrderPlanningFields } from "../OrderPlanningFields";
import { AvailableAlternatives, PurchaseComparisonItemPanel } from "./OrderDraftExportsPage";
import { createSectionedTwoColumnItemNamesPdf, exportPdfToDevice } from "../item-names-pdf";
import { draftClassificationFilters,filterDraftRowsByClassification,orderDraftPrintSections,
  type DraftClassificationFilter,type DraftPrintClassification,type DraftSectionRow } from "../order-draft-print-sections";
import type { OrderDraftItem } from "../numbered-order-drafts-core";
import { Button, Card, Notice, PageHeader } from "../ui";

type DraftRow = { draftId: number; draftOptionName?: string; item: OrderDraftItem };
type DraftPrintMode = "all" | number;
type DraftPrintRow = { id: string; itemId:number; name: string; requiredQuantity?: string };
type DraftMetrics = {
  itemId: number; revision: number; reserveQuantity: string;
  orderAlertQuantity: string | null; orderStoppedUntil: string | null;
  availableUnit1: string; saleQuantityMonth: string;
  saleTimesMonth: string; saleTimesYear: string; purchaseFactor: number;
  minOrderQuantity: string; reviewed: boolean;
  purchasePrice: string; purchaseCurrencyCode: string; requiredPurchaseValue: string | null;
  approximateCoverageDays: string | null; coverageAfterReserveDays: string | null;
  compositionCoverageDays: string | null;
};
type DraftValue = {
  id: number; itemCount: number; pricedCount: number; missingCount: number;
  totals: Array<{ currencyCode: string; value: string }>;
};
type DraftSortKey = "quantity" | "name" | "option" | "stock" | "sold" |
  "month" | "year" | "price" | "value" |
  "coverage" | "coverageWithReserve" | "compositionCoverage";
const draftColumnOptions = [
  ["select","اختيار"], ["quantity","الكمية المطلوبة (و1)"], ["name","اسم الصنف"],
  ["details","إظهار التفاصيل ⋯"], ["stock","المتوفر دون المرتجعات (و1)"],
  ["sold","الكمية المباعة في شهر (و1)"], ["month","المبيعات مرات في شهر"],
  ["year","المبيعات مرات في سنة"], ["price","سعر الشراء"], ["value","قيمة المطلوب"],
  ["action","الإجراء"], ["option","اسم الخيارات"],
  ["coverage","الكفاية بدون الاحتياط (يوم)"],
  ["coverageWithReserve","الكفاية مع الاحتياط (يوم)"],
  ["compositionCoverage","الكفاية التقريبية للتركيب (يوم)"],
] as const;
type DraftColumn = (typeof draftColumnOptions)[number][0];
// Compact laptop widths. The heading text scrolls inside these widths rather
// than expanding a column or wrapping into a tall table header.
const draftColumnWidths: Record<DraftColumn, number> = {
  select: 64, quantity: 150, name: 215, details: 39,
  stock: 89, sold: 88, month: 83, year: 83,
  price: 88, value: 96, action: 72, option: 140,
  coverage: 100, coverageWithReserve: 110, compositionCoverage: 118,
};
const defaultDraftColumns: DraftColumn[] = draftColumnOptions.slice(0, 12).map(([key]) => key);
function readDraftColumns(key: string): DraftColumn[] {
  if (typeof window === "undefined") return [...defaultDraftColumns];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [...defaultDraftColumns];
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return [...defaultDraftColumns];
    const valid = draftColumnOptions.map(([id]) => id).filter(id => stored.includes(id));
    return valid.length ? valid : [...defaultDraftColumns];
  } catch { return [...defaultDraftColumns]; }
}
type PresetGroupRun = {
  id: number; name: string; totalUnique: number;
  stages: Array<{ presetId: number; name: string; items: OrderDraftItem[] }>;
};

function DraftQuantityInput({ item, factor, onSave, onInspect }: {
  item: OrderDraftItem; factor: number | undefined;
  onSave: (quantity: string) => boolean;
  onInspect: () => void;
}) {
  const [value, setValue] = useState(item.requiredQuantity ?? "");
  const [error, setError] = useState("");
  useEffect(() => { setValue(item.requiredQuantity ?? ""); setError(""); },
    [item.id, item.requiredQuantity]);
  const lot = Number.isSafeInteger(factor) && (factor ?? 0) > 0 ? BigInt(factor!) : null;
  const save = () => {
    const normalized = normalizeDigits(value.trim());
    if (!normalized && !item.requiredQuantity) { setError(""); return; }
    if (normalized === item.requiredQuantity) { setError(""); return; }
    if (!/^[1-9]\d{0,15}$/.test(normalized)) {
      setError("الكمية يجب أن تكون عددًا صحيحًا موجبًا."); return;
    }
    if (lot && (BigInt(normalized) < lot || BigInt(normalized) % lot !== 0n)) {
      setError("الكمية يجب أن تكون عامل وحدة الشراء أو أحد مضاعفاته."); return;
    }
    if (!onSave(normalized)) { setError("تعذر حفظ الكمية على هذا الجهاز."); return; }
    setValue(normalized); setError("");
  };
  const step = (direction: 1 | -1) => {
    if (!lot) return;
    const current = /^[1-9]\d{0,15}$/.test(item.requiredQuantity ?? "")
      ? BigInt(item.requiredQuantity!) : lot;
    const result = current + BigInt(direction) * lot;
    const next = result < lot ? lot : result;
    if (next.toString().length > 16) {
      setError("وصلت الكمية إلى الحد الأعلى المسموح."); return;
    }
    if (onSave(next.toString())) { setValue(next.toString()); setError(""); }
    else setError("تعذر حفظ الكمية على هذا الجهاز.");
  };
  return <div className="order-draft-quantity-editor">
    <div className="order-draft-quantity-controls">
      <button type="button" title={"− " + (factor ?? "—")}
        aria-label={"نقص كمية " + item.name + " بمقدار عامل وحدة الشراء"}
        disabled={!!item.deleted || !lot} onClick={() => { onInspect(); step(-1); }}>−</button>
      <input aria-label={"الكمية المطلوبة للصنف " + item.name} inputMode="numeric"
        value={value} disabled={!!item.deleted} onFocus={onInspect} onChange={event => {
          setValue(event.target.value); setError("");
        }} onBlur={save} onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        }} placeholder="—" />
      <button type="button" title={"+ " + (factor ?? "—")}
        aria-label={"زيادة كمية " + item.name + " بمقدار عامل وحدة الشراء"}
        disabled={!!item.deleted || !lot} onClick={() => { onInspect(); step(1); }}>+</button>
    </div>
    {error && !item.deleted && <small role="alert">{error}</small>}
  </div>;
}

export function ItemOrderDraftsPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const drafts = useNumberedOrderDrafts(companyId, user?.id);
  const directory = usePageDirectory(companyId);
  const itemListAccess = directory.data?.find(entry => entry.key === "company.item-options-list");
  const canEditPlanning = !!itemListAccess?.enabled && !!itemListAccess.actionAccess.edit;
  const [search, setSearch] = useState("");
  const [draftFilter, setDraftFilter] = useState("all");
  const [status, setStatus] = useState("all");
  const [reviewFilter, setReviewFilter] = useState<"all" | "reviewed" | "unreviewed">("all");
  const [classificationFilters,setClassificationFilters]=useState<Set<DraftClassificationFilter>>(
    ()=>new Set(draftClassificationFilters.map(option=>option.value)));
  const [page, setPage] = useState(1);
  const [mobileD13,setMobileD13]=useState(false);
  const [sortKey, setSortKey] = useState<DraftSortKey | null>("value");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const columnsStorageKey = "alraesy:order-drafts-columns:v1:" +
    companyId + ":" + (user?.id ?? "guest");
  const [visibleColumns, setVisibleColumns] = useState<DraftColumn[]>(
    () => readDraftColumns(columnsStorageKey));
  const [editingColumns, setEditingColumns] = useState<DraftColumn[]>(visibleColumns);
  const [columnsDialogOpen, setColumnsDialogOpen] = useState(false);
  useEffect(() => {
    const selected = readDraftColumns(columnsStorageKey);
    setVisibleColumns(selected);
    setEditingColumns(selected);
    setColumnsDialogOpen(false);
  }, [columnsStorageKey]);
  const columnStyle=(column:DraftColumn)=>visibleColumns.includes(column)?undefined:{display:"none" as const};
  const defaultColumnLayout=visibleColumns.length===defaultDraftColumns.length&&
    defaultDraftColumns.every(column=>visibleColumns.includes(column));
  const needsItemCoverage = visibleColumns.includes("coverage") ||
    visibleColumns.includes("coverageWithReserve") ||
    sortKey === "coverage" || sortKey === "coverageWithReserve";
  const needsCompositionCoverage = visibleColumns.includes("compositionCoverage") ||
    sortKey === "compositionCoverage";
  // Sorting is captured once on load or after an explicit header/mobile sort.
  // Saving a review flag or a required quantity must not move the edited row.
  const [sortVersion, setSortVersion] = useState(0);
  const [sortSnapshot, setSortSnapshot] = useState<{
    version: number; memberKey: string; orderedItemIds: number[];
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [sidePanel, setSidePanel] = useState<{
    itemId: number; itemName: string; view: "purchase" | "movement";
  } | null>(null);
  const revealSidePanel = useRef(false);
  const showItemDetails = (itemId: number, itemName: string, revealOnMobile = false) => {
    revealSidePanel.current = revealOnMobile;
    setSidePanel(current => ({
      itemId, itemName, view: current?.view ?? "purchase",
    }));
  };
  useEffect(() => {
    if (!sidePanel || !revealSidePanel.current) return;
    revealSidePanel.current = false;
    if (window.matchMedia("(max-width: 900px)").matches) {
      document.getElementById("item-order-drafts-detail-pane")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [sidePanel]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [expandedItemId, setExpandedItemId] = useState<number | null>(null);
  const [printSnapshot,setPrintSnapshot]=useState<DraftSectionRow<DraftPrintRow>[][]|null>(null);
  useEffect(()=>{
    const clear=()=>setPrintSnapshot(null);
    window.addEventListener("afterprint",clear);
    return ()=>window.removeEventListener("afterprint",clear);
  },[]);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [draftActionNotice, setDraftActionNotice] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupMessage, setGroupMessage] = useState<{ error: boolean; text: string } | null>(null);
  const groupBase = "/companies/" + companyId + "/item-options-list/preset-groups";
  const groupsQuery = useQuery({
    queryKey: ["company-item-options-preset-groups", companyId, user?.id],
    queryFn: ({ signal }) => api<{ items: ItemOptionsPresetGroup[] }>(groupBase, { signal }),
    enabled: !!user, staleTime: 0,
  });
  const groups = groupsQuery.data?.items ?? [];
  const currentGroup = groups.find(group => String(group.id) === selectedGroupId);
  // Export active items in stable draft order within each print group, without headings.
  // A deleted item stays in local storage but is omitted from print/PDF output.
  const printableRows = (mode: DraftPrintMode): DraftPrintRow[] =>
    drafts.drafts.filter(draft => mode === "all" || draft.id === mode)
      .flatMap(draft => draft.items.filter(item => !item.deleted).map(item => ({
        id: draft.id + ":" + item.id,
        itemId: item.id,
        name: item.name,
        requiredQuantity: item.requiredQuantity ?? "—",
      })));
  const allPrintable = printableRows("all");
  const printQueryClient=useQueryClient();
  type PrintClassificationResult={items:{itemId:number;compositionClassification:DraftPrintClassification}[]};
  const printBatches=(rows:readonly {itemId:number}[])=>{
    const ids=[...new Set(rows.map(row=>row.itemId))].sort((a,b)=>a-b);
    return Array.from({length:Math.ceil(ids.length/300)},(_,index)=>ids.slice(index*300,(index+1)*300));
  };
  const printClassificationOptions=(ids:number[])=>({
    queryKey:["order-draft-print-classifications",user?.id,companyId,ids.join(",")],
    queryFn:({signal}:{signal:AbortSignal})=>api<PrintClassificationResult>(
      `/companies/${companyId}/item-options-list/draft-print-classifications`,
      {method:"POST",body:{ids},signal}),
    staleTime:30000,
    retry:false,
  });
  const printClassQueries=useQueries({
    queries:printBatches(allPrintable).map(ids=>({...printClassificationOptions(ids),enabled:!!user})),
  });
  const toClassifications=(items:PrintClassificationResult["items"])=>
    new Map(items.map(item=>[item.itemId,item.compositionClassification] as const));
  const currentPrintClassifications=toClassifications(printClassQueries.flatMap(result=>result.data?.items??[]));
  const printSections = printSnapshot ?? orderDraftPrintSections(allPrintable,currentPrintClassifications) ?? [];

  const [savingExport, setSavingExport] = useState(false);
  const saveFullDraftExport = async () => {
    // Record ALL active items from ALL drafts, regardless of the print/PDF subset.
    // A single request preserves atomicity; database prevents company/item/day duplicates.
    const uniqueItems = [...new Map(drafts.drafts.flatMap(draft => draft.items)
      .filter(item => !item.deleted)
      .map(item => [item.id, { id: item.id, requiredQuantity: item.requiredQuantity ?? null }])).values()];
    if (!uniqueItems.length) return { added: 0, skipped: 0 };
    return api<{ added: number; skipped: number }>(
      "/companies/" + companyId + "/order-draft-exports",
      { method: "POST", body: { items: uniqueItems } });
  };
  const sectionsFor=async(mode:DraftPrintMode)=>{
    const rows=printableRows(mode);
    const prefetchFresh=printClassQueries.every(q=>q.isSuccess&&Date.now()-q.dataUpdatedAt<30000);
    const prefetched=prefetchFresh?orderDraftPrintSections(rows,currentPrintClassifications):null;
    if(prefetched)return prefetched;
    const responses=await Promise.all(printBatches(rows).map(ids=>printQueryClient.fetchQuery(printClassificationOptions(ids))));
    const sections=orderDraftPrintSections(rows,toClassifications(responses.flatMap(data=>data.items)));
    if(sections===null)throw new Error("تعذّر التحقق من تصنيف بعض الأصناف. حدّث بيانات المسودة ثم حاول مجددًا.");
    return sections;
  };
  const printDraft = async (mode: DraftPrintMode) => {
    if (savingExport || !printableRows(mode).length) return;
    setSavingExport(true);
    setDraftActionNotice("");
    try {
      const sections=await sectionsFor(mode);
      const saved = await saveFullDraftExport();
      flushSync(() => setPrintSnapshot(sections));
      window.print();
      setDraftActionNotice("تم حفظ جميع أصناف المسودة في سجل الشركة: " + saved.added +
        " جديد، و" + saved.skipped + " سبق ترحيله اليوم.");
    } catch (cause) {
      setDraftActionNotice("تعذر حفظ المسودة قبل الطباعة: " + errorMessage(cause));
    } finally { setSavingExport(false); }
  };
  const exportDraftPdf = async (mode: DraftPrintMode) => {
    if (exportingPdf || savingExport) return;
    const items = printableRows(mode);
    if (!items.length) return;
    setExportingPdf(true);
    setDraftActionNotice("");
    try {
      const pdf = createSectionedTwoColumnItemNamesPdf(await sectionsFor(mode));
      const filename = "item-order-" + (mode === "all" ? "all" : "draft-" + mode) +
        "-" + new Date().toLocaleDateString("en-CA") + ".pdf";
      // Save the central snapshot before creating the exported device file.
      const saved = await saveFullDraftExport();
      const result = await exportPdfToDevice(pdf, filename);
      setDraftActionNotice((result === "shared" ? "أُنشئ PDF للمشاركة. " : "تم تنزيل PDF. ") +
        "سُجلت جميع الأصناف في الشركة: " + saved.added + " جديد، و" +
        saved.skipped + " سبق ترحيله اليوم.");
    } catch (cause) {
      setDraftActionNotice("تعذر ترحيل PDF: " + errorMessage(cause));
    } finally { setExportingPdf(false); }
  };
  const deleteWholeDraft = (id: number, count: number) => {
    if (!window.confirm("هل تريد حذف مسودة " + id + " نهائيًا بكل أصنافها (" + count +
      ") من هذا الجهاز؟ لا يمكن إرجاع المسودة المحذوفة، وستظل المسودات الأخرى كما هي.")) return;
    if (drafts.deleteDraft(id)) {
      setSelectedIds(new Set());
      setExpandedItemId(null);
      setDraftFilter("all");
      setDraftActionNotice("تم حذف المسودة " + id + " نهائيًا من الجهاز.");
    }
  };
  const rows = useMemo<DraftRow[]>(() => drafts.drafts.flatMap(draft =>
    draft.items.map(item => ({ draftId: draft.id,
      draftOptionName: draft.sourceOptionName, item }))), [drafts.drafts]);
  // A local draft can expire or be deleted while the page is open. Avoid
  // keeping an inspection pane pointed at an item no longer in any draft.
  useEffect(() => {
    if (sidePanel && !rows.some(row => row.item.id === sidePanel.itemId)) {
      setSidePanel(null);
    }
  }, [rows, sidePanel?.itemId]);
  const activeCount = rows.filter(row => !row.item.deleted).length;
  const removedCount = rows.length - activeCount;
  // Load all draft facts in authorized chunks so sorting works across the
  // entire locally saved draft list, not merely the current visible page.
  const metricRequests = rows.map(row => ({
    id: row.item.id,
    // Keep per-item value for display and sorting even after soft deletion.
    // Only draftValuesInput below excludes deleted items from header totals.
    requiredQuantity: row.item.requiredQuantity ?? null,
  }));
  const metricBatches = Array.from({ length: Math.ceil(metricRequests.length / 300) },
    (_, index) => metricRequests.slice(index * 300, (index + 1) * 300));
  const metricResults = useQueries({
    queries: metricBatches.map(items => ({
      queryKey: ["item-order-draft-review", companyId, user?.id, JSON.stringify(items),
        needsItemCoverage, needsCompositionCoverage],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<{ items: DraftMetrics[] }>("/companies/" + companyId + "/item-options-list/draft-review",
          { method: "POST", body: { items, includeCoverage: needsItemCoverage,
            includeCompositionCoverage: needsCompositionCoverage }, signal }),
      enabled: !!user && items.length > 0,
      staleTime: 30_000,
    })),
  });
  const metricsById = new Map(metricResults.flatMap(result => result.data?.items ?? [])
    .map(item => [item.itemId, item]));
  const metricsLoading = metricResults.some(result => result.isPending || result.isFetching);
  const metricsError = metricResults.find(result => result.error)?.error;
  // Reviewed is an authoritative item-card flag from the draft-review API.
  // Never treat an unloaded or failed metric as "غير مراجع".
  const reviewFilterReady = reviewFilter === "all" ||
    metricResults.every(result => result.isSuccess);
  const filteredBeforeClassification = useMemo(() => {
    if (!reviewFilterReady) return [];
    const q = search.trim().toLocaleLowerCase();
    return rows.filter(row => (draftFilter === "all" || String(row.draftId) === draftFilter)
      && (status === "all" || (status === "deleted" ? !!row.item.deleted : !row.item.deleted))
      && (!q || [row.item.name, row.item.code, row.item.sourceOptionName ?? row.draftOptionName ?? "",
        String(row.draftId)].some(value => value.toLocaleLowerCase().includes(q)))
      && (reviewFilter === "all" || (metricsById.get(row.item.id)?.reviewed ===
        (reviewFilter === "reviewed"))));
  }, [rows, search, draftFilter, status, reviewFilter, reviewFilterReady, metricsById]);
  const classificationNarrowed = classificationFilters.size > 0 &&
    classificationFilters.size < draftClassificationFilters.length;
  const activePrintIds = new Set(allPrintable.map(row=>row.itemId));
  // The existing print cache covers active rows; query only additional relevant
  // IDs (e.g. items that exist solely as deleted rows) using the same projection.
  const extraClassificationBatches = classificationNarrowed ?
    printBatches(filteredBeforeClassification.filter(row=>!activePrintIds.has(row.item.id))
      .map(row=>({itemId:row.item.id}))) : [];
  const extraClassificationQueries = useQueries({
    queries:extraClassificationBatches.map(ids=>({...printClassificationOptions(ids),enabled:!!user})),
  });
  const classificationsForView = new Map(currentPrintClassifications);
  for (const query of extraClassificationQueries) {
    for (const row of query.data?.items ?? []) {
      classificationsForView.set(row.itemId,row.compositionClassification);
    }
  }
  const classifiedRows = filterDraftRowsByClassification(filteredBeforeClassification,row=>row.item.id,
    classificationFilters,classificationsForView);
  const classificationFilterReady = classifiedRows !== null;
  const classificationFilterLoading = !classificationFilterReady &&
    [...printClassQueries,...extraClassificationQueries].some(query=>query.isPending || query.isFetching);
  const filtered = classifiedRows ?? [];
  const draftValuesInput = drafts.drafts.map(draft => ({
    id: draft.id,
    items: draft.items.filter(item => !item.deleted).map(item => ({
      id: item.id, requiredQuantity: item.requiredQuantity ?? null,
    })),
  }));
  const draftValuesQuery = useQuery({
    queryKey: ["item-order-draft-total-values", companyId, user?.id, JSON.stringify(draftValuesInput)],
    queryFn: ({ signal }) => api<{ drafts: DraftValue[] }>(
      "/companies/" + companyId + "/item-options-list/draft-values",
      { method: "POST", body: { drafts: draftValuesInput }, signal }),
    enabled: !!user && draftValuesInput.length > 0,
    staleTime: 30_000,
  });
  const draftTotalsById = new Map((draftValuesQuery.data?.drafts ?? []).map(row => [row.id, row]));
  // Server totals are exact four-decimal strings. Never sum currencies using
  // IEEE floating point or mix different currencies into an ambiguous total.
  const grandTotals = new Map<string, bigint>();
  for (const draft of draftValuesQuery.data?.drafts ?? []) {
    for (const total of draft.totals) {
      const [integer, decimals = ""] = total.value.split(".");
      const amount = BigInt(integer) * 10000n +
        BigInt((decimals + "0000").slice(0, 4)) * (integer.startsWith("-") ? -1n : 1n);
      grandTotals.set(total.currencyCode, (grandTotals.get(total.currencyCode) ?? 0n) + amount);
    }
  }
  const formatScaledTotal = (amount: bigint) => {
    const absolute = amount < 0n ? -amount : amount;
    return formatNumber((amount < 0n ? "-" : "") +
      (absolute / 10000n).toString() + "." + String(absolute % 10000n).padStart(4, "0"));
  };
  // Shared across desktop controls and the mobile sticky summary: same exact
  // server-calculated total, excluding soft-deleted draft items.
  const grandTotalDisplay = draftValuesQuery.data
    ? (grandTotals.size > 0 ? [...grandTotals].map(([currency, amount], i) =>
        <span key={currency}>{i > 0 ? " ؛ " : ""}
          <bdi>{formatScaledTotal(amount)} {currency}</bdi>
        </span>) : "0")
    : "—";

  const compareNumeric = (left: string | null | undefined, right: string | null | undefined) =>
    Number(left ?? 0) - Number(right ?? 0);
  const sortValue = (row: DraftRow) => {
    const info = metricsById.get(row.item.id);
    switch (sortKey) {
      case "quantity": return row.item.requiredQuantity ?? "0";
      case "name": return row.item.name;
      case "option": return row.item.sourceOptionName ?? row.draftOptionName ?? "";
      case "stock": return info?.availableUnit1 ?? "0";
      case "sold": return info?.saleQuantityMonth ?? "0";
      case "month": return info?.saleTimesMonth ?? "0";
      case "year": return info?.saleTimesYear ?? "0";
      case "price": return info?.purchasePrice ?? "0";
      case "value": return info?.requiredPurchaseValue ?? "0";
      case "coverage": return info?.approximateCoverageDays ?? "0";
      case "coverageWithReserve": return info?.coverageAfterReserveDays ?? "0";
      case "compositionCoverage": return info?.compositionCoverageDays ?? "0";
      default: return "";
    }
  };
  // Rank all draft rows before filtering and pagination.
  const sortMemberKey = rows.map(row => row.draftId + ":" + row.item.id).join(",");
  useEffect(() => {
    if (metricsLoading || metricsError) return;
    if (sortSnapshot?.version === sortVersion && sortSnapshot.memberKey === sortMemberKey) return;
    const orderedItemIds = [...rows].sort((left, right) => {
      if (!sortKey) return 0; // Explicitly restore the original draft order.
      const a = sortValue(left), b = sortValue(right);
      const result = sortKey === "name" || sortKey === "option"
        ? a.localeCompare(b, "ar", { numeric: true }) : compareNumeric(a, b);
      return (sortDir === "asc" ? 1 : -1) * result || left.item.id - right.item.id;
    }).map(row => row.item.id);
    setSortSnapshot({ version: sortVersion, memberKey: sortMemberKey, orderedItemIds });
  }, [rows, sortMemberKey, sortVersion, sortKey, sortDir, metricsById,
    metricsLoading, metricsError, sortSnapshot]);
  // Updating requiredQuantity invalidates metrics, and reviewing invalidates
  // draft-review queries. Neither event changes this captured row order.
  const sortRanks = new Map((sortSnapshot?.orderedItemIds ?? [])
    .map((id, index) => [id, index] as const));
  const sorted = [...filtered].sort((left, right) => {
    const a = sortRanks.get(left.item.id);
    const b = sortRanks.get(right.item.id);
    if (a === undefined && b === undefined) return 0;
    return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
  });
  const pageSize = 300;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visible = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const visibleActiveIds = visible.filter(row => !row.item.deleted).map(row => row.item.id);
  const selectedActiveIds = rows.filter(row => !row.item.deleted && selectedIds.has(row.item.id))
    .map(row => row.item.id);
  const allVisibleSelected = visibleActiveIds.length > 0
    && visibleActiveIds.every(id => selectedIds.has(id));
  const resetPage = () => setPage(1);
  const sortDraftColumn=(key:DraftColumn)=>{
    if(key==="select"||key==="details"||key==="action")return;
    setSortDir(sortKey===key&&sortDir==="asc"?"desc":"asc");
    setSortKey(key);setSortVersion(version=>version+1);setPage(1);
  };

  const applyColumns = () => {
    if (!editingColumns.length) return;
    const next = draftColumnOptions.map(([key]) => key)
      .filter(key => editingColumns.includes(key));
    setVisibleColumns(next);
    setColumnsDialogOpen(false);
    try { window.localStorage.setItem(columnsStorageKey, JSON.stringify(next)); }
    catch { /* Browsers with disabled storage still keep the current selection. */ }
  };
  const optionName = (row: DraftRow) =>
    row.item.sourceOptionName ?? row.draftOptionName ?? "غير مسجل (مسودة سابقة)";
  const selectItem = (id: number, checked: boolean) => setSelectedIds(before => {
    const after = new Set(before);
    if (checked) after.add(id); else after.delete(id);
    return after;
  });
  const selectVisible = (checked: boolean) => setSelectedIds(before => {
    const after = new Set(before);
    for (const id of visibleActiveIds) {
      if (checked) after.add(id); else after.delete(id);
    }
    return after;
  });
  const deleteSelected = () => {
    if (!selectedActiveIds.length) return;
    if (drafts.setItemsDeleted(selectedActiveIds, true)) setSelectedIds(new Set());
  };

  async function runPresetGroup(group: ItemOptionsPresetGroup) {
    if (groupBusy || !drafts.enabled) return;
    setGroupBusy(true); setGroupMessage(null);
    try {
      const prepared = await api<{ result: PresetGroupRun }>(
        groupBase + "/" + group.id + "/prepare", { method: "POST", body: {} },
      );
      if (!prepared.result.totalUnique) {
        setGroupMessage({ error: true, text: "لا توجد أصناف مطابقة لأي خيار؛ لم تتغير المسودات السابقة." });
        return;
      }
      const stages = prepared.result.stages;
      const saved = drafts.replaceFromPresetGroup(
        stages.map(stage => stage.items), stages.map(stage => stage.name),
      );
      if (!saved) {
        setGroupMessage({ error: true, text: "تعذر حفظ التجميع. بقيت المسودات السابقة كما هي؛ راجع مساحة التخزين." });
        return;
      }
      setSelectedIds(new Set()); setSidePanel(null);
      setDraftFilter("all"); setStatus("all"); resetPage();
      setGroupMessage({ error: false,
        text: "تم ترحيل «" + group.name + "» إلى " + saved.drafts +
          " مسودات محلية تضم " + saved.added + " صنفًا، واستُبدلت المسودات السابقة." });
    } catch (cause) {
      setGroupMessage({ error: true, text: "تعذر ترحيل التجميع: " + errorMessage(cause) });
    } finally { setGroupBusy(false); }
  }
  const planningControls = (row: DraftRow, info: DraftMetrics | undefined) =>
    <OrderPlanningFields companyId={companyId} itemId={row.item.id} itemName={row.item.name}
      info={info} canEdit={canEditPlanning} />;
  const togglePlanning = (id: number) => setExpandedItemId(current => current === id ? null : id);
  const moreButton = (row: DraftRow) =>
    <button type="button" className="item-order-draft-expand-button"
      aria-label={"إظهار أو إخفاء بيانات الطلب والاحتياط والإيقاف للصنف " + row.item.name}
      aria-expanded={expandedItemId === row.item.id}
      title={expandedItemId === row.item.id ? "إخفاء التفاصيل" : "إظهار المزيد"}
      onClick={() => togglePlanning(row.item.id)}>⋯</button>;
  const action = (row: DraftRow) => row.item.deleted
    ? <Button size="compact" variant="secondary"
        onClick={() => drafts.setItemDeleted(row.draftId, row.item.id, false)}>إرجاع الحذف</Button>
    : <Button size="compact" variant="danger" onClick={() => {
        if (drafts.setItemDeleted(row.draftId, row.item.id, true)) selectItem(row.item.id, false);
      }}>حذف</Button>;

  const draftCell=(column:DraftColumn,row:DraftRow)=>{
    const info=metricsById.get(row.item.id);
    switch(column){
      case "select": return <><input type="checkbox" aria-label={"اختيار " + row.item.name}
                  disabled={!!row.item.deleted} checked={!row.item.deleted && selectedIds.has(row.item.id)}
                  onChange={event => {
                  selectItem(row.item.id, event.target.checked);
                  showItemDetails(row.item.id, row.item.name, true);
                }} /></>;
      case "quantity": return <><DraftQuantityInput item={row.item} factor={info?.purchaseFactor}
                  onInspect={() => showItemDetails(row.item.id, row.item.name)}
                  onSave={quantity => drafts.updateItemQuantity(row.draftId, row.item.id, quantity)} /></>;
      case "name": return <><span className="company-item-label">{row.item.deleted?<s>{row.item.name}</s>:row.item.name}</span>
                {row.item.deleted && <strong className="item-order-deleted-label"> محذوف</strong>}</>;
      case "details": return <>{moreButton(row)}</>;
      case "stock": return <><span className="item-order-drafts-stock-quantity"><bdi>{formatStockSaleQuantity(info?.availableUnit1)}</bdi></span></>;
      case "sold": return <><span className="item-order-drafts-sold-quantity"><bdi>{formatStockSaleQuantity(info?.saleQuantityMonth)}</bdi></span></>;
      case "month": return <><bdi>{formatNumber(info?.saleTimesMonth)}</bdi></>;
      case "year": return <><bdi>{formatNumber(info?.saleTimesYear)}</bdi></>;
      case "price": return <><bdi>{formatNumber(info?.purchasePrice)}</bdi></>;
      case "value": return <><bdi>{formatNumber(info?.requiredPurchaseValue)}</bdi></>;
      case "action": return <><div className="item-order-draft-inline-actions">{action(row)}</div></>;
      case "option": return <>{optionName(row)}</>;
      case "coverage": return <><bdi>{formatNumber(info?.approximateCoverageDays)}</bdi></>;
      case "coverageWithReserve": return <><bdi>{formatNumber(info?.coverageAfterReserveDays)}</bdi></>;
      case "compositionCoverage": return <><bdi>{formatNumber(info?.compositionCoverageDays)}</bdi></>;
    }
  };
  const desktopDraftColumns:InteractiveTableColumn<DraftRow,DraftColumn>[]=
    draftColumnOptions.map(([key,label])=>({
      key,label,width:draftColumnWidths[key],cell:row=>draftCell(key,row),
      sortable:key!=="select"&&key!=="details"&&key!=="action",
      scrollText:key!=="select"&&key!=="quantity"&&key!=="details"&&key!=="action",
      header:key==="select"?<input type="checkbox" aria-label="اختيار جميع أصناف الصفحة غير المحذوفة"
        disabled={!visibleActiveIds.length} checked={allVisibleSelected}
        onChange={event=>selectVisible(event.currentTarget.checked)} />:undefined,
    }));

  return <div className={`wallet-page item-order-drafts-page${mobileD13?" is-mobile-d13":""}`}>
    <PageHeader title="متابعة مسودات الطلبيات"
      description="جميع أصناف المسودات المحفوظة محليًا على هذا الجهاز"
      actions={<><Link className="button button-secondary"
        to={"/companies/" + companyId + "/item-options-list"}>قائمة الأصناف</Link>
        <Link className="button button-secondary" to={"/companies/" + companyId + "/order-draft-exports"}>الطلبيات المرحلة</Link>
        <Link className="button button-secondary" to={"/companies/" + companyId + "/item-order-levels"}>أصناف حد الطلب</Link></>} />
    <p className="muted">الحذف يضع علامة «محذوف» ويمكن إرجاع الصنف. تُستبعد الأصناف المحذوفة من قيمة المطلوب والطباعة، لكنها تبقى في المسودة. المسودات محلية وتنتهي بعد 8 ساعات من إنشائها.</p>
    {drafts.error && <Notice tone="error">{drafts.error}</Notice>}
    <Card title="اختيار تجميع الخيارات المحفوظ">
      <div className="item-order-drafts-group-actions">
        <label>تجميع الخيارات
          <select aria-label="اختيار تجميع خيارات للترحيل من متابعة المسودات"
            value={selectedGroupId} disabled={groupBusy || groupsQuery.isFetching}
            onChange={event => {
              const id = event.target.value;
              setSelectedGroupId(id);
              const group = groups.find(row => String(row.id) === id);
              if (group) void runPresetGroup(group);
            }}>
            <option value="">اختر تجميعًا لتشغيله</option>
            {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <Button type="button" variant="secondary" disabled={!currentGroup || groupBusy}
          onClick={() => { if (currentGroup) void runPresetGroup(currentGroup); }}>
          {groupBusy ? "جارٍ تجهيز المسودات…" : "إعادة تشغيل التجميع"}
        </Button>
        <Button type="button" variant="secondary" disabled={groupBusy || groupsQuery.isFetching}
          onClick={() => void groupsQuery.refetch()}>تحديث التجميعات</Button>
      </div>
      <small className="muted">اختيار تجميع جديد ينفّذ مراحله بالترتيب ويستبدل جميع المسودات السابقة على هذا الجهاز، كما في «قائمة الأصناف».</small>
      {groupsQuery.error && <Notice tone="error">{errorMessage(groupsQuery.error)}</Notice>}
      {groupMessage && <Notice tone={groupMessage.error ? "error" : "success"}>{groupMessage.text}</Notice>}
    </Card>
    <Card title="قيمة الطلبيات بعد تعديل الكميات">
      {draftValuesQuery.isPending && drafts.drafts.length > 0 &&
        <small role="status" className="muted">جارٍ حساب قيم المسودات…</small>}
      {draftValuesQuery.isError &&
        <Notice tone="error">تعذر حساب قيم المسودات: {errorMessage(draftValuesQuery.error)}</Notice>}
      <div className="item-order-drafts-total-list">
        {drafts.drafts.map(draft => {
          const value = draftTotalsById.get(draft.id);
          return <div key={draft.id} className="item-order-drafts-total-row">
            <strong>مسودة {draft.id} — {draft.sourceOptionName ?? "خيارات متعددة"}</strong>
            <span>{value
              ? (value.totals.length ? value.totals.map((total, i) =>
                  <span key={total.currencyCode}>{i > 0 ? " ؛ " : ""}
                    <bdi>{formatNumber(total.value)} {total.currencyCode}</bdi>
                  </span>) : "0") : "—"}
              {value && value.missingCount > 0 &&
                <small className="muted"> ({value.missingCount} صنف دون سعر أو كمية)</small>}
            </span>
            <details className="item-order-drafts-card-actions">
              <summary aria-label={"إجراءات مسودة " + draft.id} title="إجراءات المسودة">⋯</summary>
              <div className="item-order-drafts-card-menu">
                <Button size="compact" variant="secondary"
                  disabled={savingExport || !draft.items.some(item => !item.deleted)}
                  onClick={() => void printDraft(draft.id)}>طباعة المسودة</Button>
                <Button size="compact" variant="secondary"
                  disabled={exportingPdf || !draft.items.some(item => !item.deleted)}
                  onClick={() => void exportDraftPdf(draft.id)}>
                  {exportingPdf ? "جارٍ تجهيز PDF…" : "ترحيل إلى PDF"}
                </Button>
                <Button size="compact" variant="danger"
                  onClick={() => deleteWholeDraft(draft.id, draft.items.length)}>حذف المسودة نهائيًا</Button>
              </div>
            </details>
          </div>;
        })}
      </div>
      <div className="item-order-drafts-all-actions">
        <Button variant="secondary" disabled={savingExport || !allPrintable.length}
          onClick={() => void printDraft("all")}>طباعة الكل</Button>
        <Button variant="secondary" disabled={exportingPdf || !allPrintable.length}
          onClick={() => void exportDraftPdf("all")}>
          {exportingPdf ? "جارٍ تجهيز PDF…" : "ترحيل الكل PDF"}
        </Button>
      </div>
      {draftActionNotice && <Notice>{draftActionNotice}</Notice>}
    </Card>
    <div className="item-order-drafts-split-layout">
    <Card title={"المسودات: " + drafts.drafts.length + " — الأصناف الفعالة: " + activeCount + " — المحذوفة: " + removedCount}>
      <div className="item-order-drafts-review-filter" role="group"
        aria-label="تصفية مسودات الطلبيات حسب مراجعة الصنف">
        {([
          { value: "all", label: "إظهار الكل" },
          { value: "reviewed", label: "إظهار المراجع" },
          { value: "unreviewed", label: "إظهار غير المراجع" },
        ] as const).map(option => (
          <Button key={option.value} size="compact"
            variant={reviewFilter === option.value ? "primary" : "secondary"}
            aria-pressed={reviewFilter === option.value}
            onClick={() => {
              setReviewFilter(option.value);
              setSelectedIds(new Set());
              setSidePanel(null);
              resetPage();
            }}>{option.label}</Button>
        ))}
      </div>
      <div className="item-order-drafts-classification-filter" role="group" aria-label="تصفية حسب التصنيف">
        {draftClassificationFilters.map(option => <label key={option.value}>
          <input type="checkbox" checked={classificationFilters.has(option.value)}
            onChange={event => {
              const checked=event.currentTarget.checked;
              setClassificationFilters(previous=>{
                const next=new Set(previous);
                if(checked)next.add(option.value); else next.delete(option.value);
                return next;
              });
              setSelectedIds(new Set());
              setSidePanel(null);
              resetPage();
            }} />
          {option.label}
        </label>)}
      </div>
      <div className="item-order-drafts-filters">
        <label>البحث عن صنف أو اسم خيارات
          <input type="search" value={search} onChange={event => {
            setSearch(event.target.value); setSidePanel(null); resetPage();
          }}
            placeholder="اسم الصنف أو اسم الخيارات" />
        </label>
        <label>المسودة
          <select value={draftFilter} onChange={event => {
            setDraftFilter(event.target.value); setSidePanel(null); resetPage();
          }}>
            <option value="all">كل المسودات</option>
            {drafts.drafts.map(draft => <option key={draft.id} value={draft.id}>
              مسودة الطلبية {draft.id} — {draft.sourceOptionName ?? "خيارات متعددة"}
            </option>)}
          </select>
        </label>
        <label>الحالة
          <select value={status} onChange={event => {
            setStatus(event.target.value); setSidePanel(null); resetPage();
          }}>
            <option value="all">الجميع</option>
            <option value="active">غير المحذوفة</option>
            <option value="deleted">المحذوفة</option>
          </select>
        </label>
      </div>
      <div className="item-order-drafts-mobile-sort">
        <label>ترتيب حسب العمود
          <select aria-label="ترتيب مسودات الطلبيات حسب العمود" value={sortKey ?? ""}
            onChange={event => {
              setSortKey((event.target.value || null) as DraftSortKey | null);
              setSortDir("asc"); setSortVersion(version => version + 1); resetPage();
            }}>
            <option value="">ترتيب المسودات الأصلي</option>
            <option value="quantity">الكمية المطلوبة</option>
            <option value="name">اسم الصنف</option>
            <option value="stock">الكمية المتوفرة</option>
            <option value="sold">الكمية المباعة في شهر</option>
            <option value="month">مرات المبيعات في شهر</option>
            <option value="year">مرات المبيعات في سنة</option>
            <option value="price">سعر الشراء</option>
            <option value="value">قيمة المطلوب</option>
            <option value="option">اسم الخيارات</option>
            <option value="coverage">الكفاية بدون الاحتياط (يوم)</option>
            <option value="coverageWithReserve">الكفاية مع الاحتياط (يوم)</option>
            <option value="compositionCoverage">الكفاية التقريبية للتركيب (يوم)</option>
          </select>
        </label>
        <Button variant="secondary" disabled={!sortKey}
          onClick={() => {setSortDir(value => value === "asc" ? "desc" : "asc");
            setSortVersion(version => version + 1); resetPage();}}>
          {sortDir === "asc" ? "▲ تصاعدي" : "▼ تنازلي"}
        </Button>
      </div>
      <div className="item-order-drafts-mobile-sticky-summary"
        role="status" aria-label="ملخص أصناف وقيمة الطلبيات أثناء التصفح">
        <span>الأصناف: <bdi>{filtered.length.toLocaleString("en-US")}</bdi></span>
        <span>إجمالي الطلبيات: <strong>{grandTotalDisplay}</strong></span>
      </div>
      <div className="item-order-drafts-bulk">
        <span>إجمالي الأصناف المطابقة: <bdi>{filtered.length.toLocaleString("en-US")}</bdi></span>
        <span className="item-order-drafts-bulk-total">
          <strong>إجمالي جميع المسودات:</strong> {grandTotalDisplay}
        </span>
        <Button type="button" variant="secondary" size="compact" onClick={() => {
          setEditingColumns([...visibleColumns]); setColumnsDialogOpen(true);
        }}>الأعمدة ({visibleColumns.length}/{draftColumnOptions.length})</Button>
        <Button type="button" variant="secondary" disabled={!visibleActiveIds.length}
          onClick={() => selectVisible(!allVisibleSelected)}>
          {allVisibleSelected ? "إلغاء تحديد الظاهر" : "تحديد الظاهر"}
        </Button>
        <Button type="button" variant="secondary" disabled={!selectedIds.size}
          onClick={() => setSelectedIds(new Set())}>إلغاء التحديد</Button>
        <Button type="button" variant="danger" disabled={!selectedActiveIds.length || groupBusy}
          onClick={deleteSelected}>حذف المحدد ({selectedActiveIds.length})</Button>
      </div>
      {columnsDialogOpen && <div className="item-order-drafts-columns-backdrop"
        role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setColumnsDialogOpen(false);
        }}>
        <div className="item-order-drafts-columns-dialog" role="dialog"
          aria-modal="true" aria-labelledby="order-draft-columns-title"
          onKeyDown={event => { if (event.key === "Escape") setColumnsDialogOpen(false); }}>
          <h3 id="order-draft-columns-title">الأعمدة الظاهرة</h3>
          <p className="muted">حدد الأعمدة المطلوبة ثم اضغط «موافق». تُحفظ على هذا الجهاز لهذا المستخدم والشركة.</p>
          <div className="item-order-drafts-columns-choices">
            {draftColumnOptions.map(([key, label]) => <label key={key}>
              <input type="checkbox" checked={editingColumns.includes(key)}
                onChange={event => setEditingColumns(previous => event.target.checked
                  ? [...previous, key] : previous.filter(id => id !== key))} />
              <span>{label}</span>
            </label>)}
          </div>
          {!editingColumns.length && <Notice tone="warning">اختر عمودًا واحدًا على الأقل.</Notice>}
          <div className="form-actions">
            <Button size="compact" variant="secondary"
              onClick={() => setEditingColumns(draftColumnOptions.map(([key]) => key))}>إظهار الكل</Button>
            <Button size="compact" variant="secondary"
              onClick={() => setEditingColumns([...defaultDraftColumns])}>الافتراضي</Button>
            <Button size="compact" variant="secondary"
              onClick={() => setColumnsDialogOpen(false)}>إلغاء</Button>
            <Button size="compact" disabled={!editingColumns.length} onClick={applyColumns}>موافق</Button>
          </div>
        </div>
      </div>}
      {!classificationFilterReady && (classificationFilterLoading
        ? <small className="muted" role="status">جارٍ تحميل تصنيفات الأصناف…</small>
        : <Notice tone="error">تعذّر التحقق من تصنيف بعض الأصناف. لإظهار كل الأصناف، اختر جميع التصنيفات.</Notice>)}
      {metricsLoading && <small className="muted" role="status">جارٍ تحديث مؤشرات المبيعات والسعر والقيمة…</small>}
      {metricsError && <Notice tone="error">تعذر تحميل مؤشرات الأصناف: {errorMessage(metricsError)}</Notice>}
      {reviewFilter !== "all" && !reviewFilterReady && !metricsError &&
        <Notice>جارٍ تحميل حالات المراجعة لجميع أصناف المسودات لتطبيق الفلتر…</Notice>}
      {!drafts.drafts.length && <Notice>لا توجد مسودات محفوظة على هذا الجهاز حاليًا. أنشئ مسودة أو اختر تجميعًا أعلاه.</Notice>}
      {!!drafts.drafts.length&&<div className="item-order-drafts-mobile-table-switch">
        <Button type="button" size="compact" variant="secondary" aria-pressed={mobileD13}
          onClick={()=>setMobileD13(value=>!value)}>{mobileD13?"عرض البطاقات":"عرض الجدول"}</Button>
      </div>}
      {!!drafts.drafts.length && <InteractiveColumnsTable
        className="item-order-drafts-table-scroll" ariaLabel="قائمة أصناف جميع المسودات"
        columns={desktopDraftColumns} rows={visible} rowKey={row=>row.draftId+":"+row.item.id}
        visibleColumns={visibleColumns} storageKey={columnsStorageKey+":d13-layout"}
        sortKey={sortKey??undefined} sortDirection={sortDir} onSort={sortDraftColumn}
        dockRowSource={row=>({companyId,itemId:row.item.id,itemName:row.item.name})}
        rowClassName={row=>[row.item.deleted?"item-order-draft-deleted":"",
          sidePanel?.itemId===row.item.id?"item-order-draft-detail-selected":""].join(" ")}
        renderRowDetails={row=>expandedItemId===row.item.id?planningControls(row,metricsById.get(row.item.id)):null}
        emptyMessage={reviewFilterReady&&classificationFilterReady?"لا توجد أصناف مطابقة للخيارات الحالية.":""} />}
      {!!drafts.drafts.length && <div className="item-order-drafts-mobile-list" aria-label="متابعة الأصناف على الهاتف">
        {visible.map(row => {
          const info = metricsById.get(row.item.id);
          return <article className={"item-order-drafts-mobile-card" +
            (row.item.deleted ? " item-order-draft-deleted" : "") +
            (defaultColumnLayout ? "" : " item-order-drafts-custom-columns") +
            (sidePanel?.itemId === row.item.id ? " item-order-draft-detail-selected" : "")}
            key={row.draftId + ":" + row.item.id}>
            <div className="item-order-drafts-mobile-top">
              <input type="checkbox" style={columnStyle("select")} aria-label={"اختيار " + row.item.name}
                disabled={!!row.item.deleted} checked={!row.item.deleted && selectedIds.has(row.item.id)}
                onChange={event => {
                  selectItem(row.item.id, event.target.checked);
                  showItemDetails(row.item.id, row.item.name, true);
                }} />
              <div className="item-order-drafts-mobile-quantity" style={columnStyle("quantity")}>
                <DraftQuantityInput item={row.item} factor={info?.purchaseFactor}
                  onInspect={() => showItemDetails(row.item.id, row.item.name)}
                  onSave={quantity => drafts.updateItemQuantity(row.draftId, row.item.id, quantity)} />
              </div>
              <span className="item-order-drafts-mobile-name" style={columnStyle("name")}>
                <span className="company-item-label">{row.item.deleted?<s>{row.item.name}</s>:row.item.name}</span>
                {row.item.deleted && <strong className="item-order-deleted-label"> محذوف</strong>}
              </span>
              <span className="item-order-drafts-mobile-action" style={columnStyle("action")}>{action(row)}</span>
            </div>
            <div className="item-order-drafts-mobile-bottom" role="group"
              aria-label={"مؤشرات الصنف " + row.item.name}>
              {visibleColumns.includes("details") && moreButton(row)}
              <span title="المتوفر دون مخازن المرتجعات" style={columnStyle("stock")}>
                <small>المتوفر</small><bdi className="item-order-drafts-stock-quantity">{formatStockSaleQuantity(info?.availableUnit1)}</bdi>
              </span>
              <span title="الكمية المباعة في شهر" style={columnStyle("sold")}>
                <small>المباع</small><bdi className="item-order-drafts-sold-quantity">{formatStockSaleQuantity(info?.saleQuantityMonth)}</bdi>
              </span>
              <span title="المبيعات مرات في شهر" style={columnStyle("month")}><small>مرات شهر</small><bdi>{formatNumber(info?.saleTimesMonth)}</bdi></span>
              <span title="المبيعات مرات في سنة" style={columnStyle("year")}><small>مرات سنة</small><bdi>{formatNumber(info?.saleTimesYear)}</bdi></span>
              <span title="سعر الشراء" style={columnStyle("price")}><small>سعر الشراء</small><bdi>{formatNumber(info?.purchasePrice)}</bdi></span>
              <span title="قيمة المطلوب" style={columnStyle("value")}><small>قيمة المطلوب</small>
                <bdi>{formatNumber(info?.requiredPurchaseValue)}</bdi></span>
              <span title={"مسودة " + row.draftId} className="item-order-drafts-option-stat"
                style={columnStyle("option")}><small>اسم الخيارات</small>{optionName(row)}</span>
              <span title="الكفاية بدون الاحتياط (يوم)" style={columnStyle("coverage")}>
                <small>كفاية دون احتياط</small><bdi>{formatNumber(info?.approximateCoverageDays)}</bdi>
              </span>
              <span title="الكفاية مع الاحتياط (يوم)" style={columnStyle("coverageWithReserve")}>
                <small>كفاية مع احتياط</small><bdi>{formatNumber(info?.coverageAfterReserveDays)}</bdi>
              </span>
              <span title="الكفاية التقريبية للتركيب (يوم)" style={columnStyle("compositionCoverage")}>
                <small>كفاية التركيب</small><bdi>{formatNumber(info?.compositionCoverageDays)}</bdi>
              </span>
            </div>
            {expandedItemId === row.item.id &&
              <div className="item-order-drafts-mobile-third-row">
                {planningControls(row, info)}
              </div>}
          </article>;
        })}
        {reviewFilterReady && classificationFilterReady && !filtered.length &&
          <p className="muted">لا توجد أصناف مطابقة للخيارات الحالية.</p>}
      </div>}
      {pages > 1 && <div className="form-actions item-order-drafts-pagination">
        <Button variant="secondary" disabled={currentPage <= 1}
          onClick={() => setPage(currentPage - 1)}>السابق</Button>
        <span>صفحة {currentPage} من {pages}</span>
        <Button variant="secondary" disabled={currentPage >= pages}
          onClick={() => setPage(currentPage + 1)}>التالي</Button>
      </div>}
    </Card>
    <aside id="item-order-drafts-detail-pane"
      className="purchase-comparison-detail-pane item-order-drafts-detail-pane"
      aria-label="مشتريات الصنف وبدائله المتوفرة" aria-live="polite">
      {sidePanel && <>
        <Card>
          <div className="purchase-comparison-side-heading">
            <strong dir="auto">{sidePanel.itemName}</strong>
            <button type="button" className="purchase-comparison-close"
              aria-label="إغلاق تفاصيل الصنف"
              onClick={() => setSidePanel(null)}>×</button>
          </div>
          <div className="purchase-comparison-view-switch" role="group"
            aria-label="اختيار مشتريات أو حركة الصنف">
            <Button size="compact" variant={sidePanel.view === "purchase" ? "primary" : "secondary"}
              aria-pressed={sidePanel.view === "purchase"}
              onClick={() => setSidePanel(previous => previous && { ...previous, view: "purchase" })}>
              مشتريات الصنف
            </Button>
            <Button size="compact" variant={sidePanel.view === "movement" ? "primary" : "secondary"}
              aria-pressed={sidePanel.view === "movement"}
              onClick={() => setSidePanel(previous => previous && { ...previous, view: "movement" })}>
              حركة الصنف
            </Button>
          </div>
          <PurchaseComparisonItemPanel companyId={companyId} userId={user?.id}
            itemId={sidePanel.itemId} view={sidePanel.view} />
        </Card>
        <AvailableAlternatives companyId={companyId} userId={user?.id}
          itemId={sidePanel.itemId} />
      </>}
    </aside>
    </div>
    <section className="item-options-print-sheet" dir="rtl"
      aria-label="طباعة أصناف مسودات الطلبيات مع الكميات المطلوبة">
      {printSections.map((rows,index)=><div key={index} className="item-order-draft-print-section">
        <div className="item-options-print-columns">
          {rows.map(item => <div className={`item-options-print-row${item.separatorBefore?" item-order-draft-print-separator":""}`} key={item.id}>
            <bdi className="item-options-print-quantity">
              {item.requiredQuantity ?? "—"}
            </bdi>
            <span className="item-options-print-name">{item.name}</span>
          </div>)}
        </div>
      </div>)}
    </section>
  </div>;
}
