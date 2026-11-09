import { Fragment, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import type { ItemOptionsPresetGroup } from "../../../../packages/contracts/src/item-options-presets.ts";
import { normalizeDigits } from "../../../../packages/contracts/src/masters.ts";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { useNumberedOrderDrafts } from "../numbered-order-drafts";
import { usePageDirectory } from "../page-directory";
import { ItemReserveQuickEdit } from "../ItemReserveQuickEdit";
import { ItemPurchaseFactorQuickEdit } from "../ItemPurchaseFactorQuickEdit";
import { createTwoColumnItemNamesPdf, exportPdfToDevice } from "../item-names-pdf";
import type { OrderDraftItem } from "../numbered-order-drafts-core";
import { Button, Card, Notice, PageHeader } from "../ui";

type DraftRow = { draftId: number; draftOptionName?: string; item: OrderDraftItem };
type DraftPrintMode = "all" | number;
type DraftPrintRow = { id: string; name: string; requiredQuantity?: string; heading?: boolean };
type DraftMetrics = {
  itemId: number; revision: number; reserveQuantity: string;
  availableUnit1: string; saleQuantityMonth: string;
  saleTimesMonth: string; saleTimesYear: string; purchaseFactor: number;
  purchasePrice: string; purchaseCurrencyCode: string; requiredPurchaseValue: string | null;
};
type DraftValue = {
  id: number; itemCount: number; pricedCount: number; missingCount: number;
  totals: Array<{ currencyCode: string; value: string }>;
};
type DraftSortKey = "quantity" | "name" | "option" | "stock" | "sold" |
  "month" | "year" | "price" | "value";
type PresetGroupRun = {
  id: number; name: string; totalUnique: number;
  stages: Array<{ presetId: number; name: string; items: OrderDraftItem[] }>;
};

const formatNumber = (value?: string | null) => {
  if (value == null || value === "") return "—";
  const [whole, decimals = ""] = value.split(".");
  const fraction = decimals.replace(/0+$/, "");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? "." + fraction : "");
};

/** One decimal place in the display only, leaving precise item data unchanged.
 * Preserve the distinction between zero and a tiny nonzero fractional quantity. */
const formatStockSaleQuantity = (value?: string | null) => {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return formatNumber(value);
  if (Number.isInteger(number)) return formatNumber(value);
  const rounded = Math.round((Math.abs(number) + Number.EPSILON) * 10) / 10;
  if (rounded === 0) return number < 0 ? ">−0.1" : "<0.1";
  const fixed = (number < 0 ? -rounded : rounded).toFixed(1);
  const [whole, digit] = fixed.split(".");
  return formatNumber(whole) + "." + digit;
};

function DraftQuantityInput({ item, factor, onSave }: {
  item: OrderDraftItem; factor: number | undefined;
  onSave: (quantity: string) => boolean;
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
        disabled={!!item.deleted || !lot} onClick={() => step(-1)}>−</button>
      <input aria-label={"الكمية المطلوبة للصنف " + item.name} inputMode="numeric"
        value={value} disabled={!!item.deleted} onChange={event => {
          setValue(event.target.value); setError("");
        }} onBlur={save} onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        }} placeholder="—" />
      <button type="button" title={"+ " + (factor ?? "—")}
        aria-label={"زيادة كمية " + item.name + " بمقدار عامل وحدة الشراء"}
        disabled={!!item.deleted || !lot} onClick={() => step(1)}>+</button>
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
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<DraftSortKey | null>("value");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [expandedItemId, setExpandedItemId] = useState<number | null>(null);
  const [printMode, setPrintMode] = useState<DraftPrintMode>("all");
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
  // Use all active records, not the current search page. A deleted row is
  // excluded from printing but remains in the editable local draft.
  const printableRows = (mode: DraftPrintMode): DraftPrintRow[] =>
    drafts.drafts.filter(draft => mode === "all" || draft.id === mode)
      .flatMap(draft => {
        const lines = draft.items.filter(item => !item.deleted);
        if (!lines.length) return [];
        const entries: DraftPrintRow[] = lines.map(item => ({
          id: draft.id + ":" + item.id,
          name: item.name,
          requiredQuantity: item.requiredQuantity ?? "—",
        }));
        return mode === "all"
          ? [{ id: "heading:" + draft.id,
              name: "مسودة " + draft.id + " — " + (draft.sourceOptionName ?? "خيارات متعددة"),
              heading: true }, ...entries] : entries;
      });
  const printRows = printableRows(printMode);
  const allPrintable = printableRows("all");
  const printDraft = (mode: DraftPrintMode) => {
    if (!printableRows(mode).length) return;
    flushSync(() => setPrintMode(mode));
    window.print();
  };
  const exportDraftPdf = async (mode: DraftPrintMode) => {
    if (exportingPdf) return;
    const items = printableRows(mode);
    if (!items.length) return;
    setExportingPdf(true);
    setDraftActionNotice("");
    try {
      const pdf = createTwoColumnItemNamesPdf(items.map(item => ({
        name: item.name,
        requiredQuantity: item.heading ? undefined : item.requiredQuantity,
      })));
      const filename = "item-order-" + (mode === "all" ? "all" : "draft-" + mode) +
        "-" + new Date().toLocaleDateString("en-CA") + ".pdf";
      const result = await exportPdfToDevice(pdf, filename);
      setDraftActionNotice(result === "shared"
        ? "أُنشئ PDF وأُرسل إلى خيارات المشاركة للحفظ أو الإرسال."
        : "تم تجهيز ملف PDF وتنزيله عبر المتصفح.");
    } catch (cause) {
      setDraftActionNotice("تعذر تصدير PDF: " + errorMessage(cause));
    } finally {
      setExportingPdf(false);
    }
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
  const activeCount = rows.filter(row => !row.item.deleted).length;
  const removedCount = rows.length - activeCount;
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase();
    return rows.filter(row => (draftFilter === "all" || String(row.draftId) === draftFilter)
      && (status === "all" || (status === "deleted" ? !!row.item.deleted : !row.item.deleted))
      && (!q || [row.item.name, row.item.code, row.item.sourceOptionName ?? row.draftOptionName ?? "",
        String(row.draftId)].some(value => value.toLocaleLowerCase().includes(q))));
  }, [rows, search, draftFilter, status]);
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
      queryKey: ["item-order-draft-review", companyId, user?.id, JSON.stringify(items)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<{ items: DraftMetrics[] }>("/companies/" + companyId + "/item-options-list/draft-review",
          { method: "POST", body: { items }, signal }),
      enabled: !!user && items.length > 0,
      staleTime: 30_000,
    })),
  });
  const metricsById = new Map(metricResults.flatMap(result => result.data?.items ?? [])
    .map(item => [item.itemId, item]));
  const metricsLoading = metricResults.some(result => result.isPending || result.isFetching);
  const metricsError = metricResults.find(result => result.error)?.error;
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
      default: return "";
    }
  };
  const sorted = sortKey ? [...filtered].sort((left, right) => {
    const a = sortValue(left), b = sortValue(right);
    const result = sortKey === "name" || sortKey === "option"
      ? a.localeCompare(b, "ar", { numeric: true }) : compareNumeric(a, b);
    return (sortDir === "asc" ? 1 : -1) * result || left.item.id - right.item.id;
  }) : filtered;
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
  const sortHeader = (key: DraftSortKey, label: string) =>
    <th scope="col" aria-sort={sortKey === key ?
      (sortDir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" className="item-order-draft-sort" onClick={() => {
        setSortDir(sortKey === key && sortDir === "asc" ? "desc" : "asc");
        setSortKey(key);
        setPage(1);
      }} title={"ترتيب حسب " + label}>
        {label}<span aria-hidden="true">{sortKey === key ?
          (sortDir === "asc" ? " ▲" : " ▼") : " ⇵"}</span>
      </button>
    </th>;

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
      setSelectedIds(new Set()); setDraftFilter("all"); setStatus("all"); resetPage();
      setGroupMessage({ error: false,
        text: "تم ترحيل «" + group.name + "» إلى " + saved.drafts +
          " مسودات محلية تضم " + saved.added + " صنفًا، واستُبدلت المسودات السابقة." });
    } catch (cause) {
      setGroupMessage({ error: true, text: "تعذر ترحيل التجميع: " + errorMessage(cause) });
    } finally { setGroupBusy(false); }
  }
  const planningControls = (row: DraftRow, info: DraftMetrics | undefined) =>
    <div className="item-order-draft-extra-fields">
      <div className="item-order-draft-extra-field">
        <strong>كمية الاحتياط</strong>
        {info ? <ItemReserveQuickEdit companyId={companyId}
          itemId={row.item.id} revision={info.revision}
          reserveQuantity={info.reserveQuantity} canEdit={canEditPlanning} />
          : <small>جارٍ تحميل بيانات الصنف…</small>}
      </div>
      <div className="item-order-draft-extra-field">
        <strong>عامل وحدة الشراء</strong>
        {info ? <ItemPurchaseFactorQuickEdit companyId={companyId}
          itemId={row.item.id} revision={info.revision}
          purchaseFactor={info.purchaseFactor} canEdit={canEditPlanning} />
          : <small>جارٍ تحميل بيانات الصنف…</small>}
      </div>
      {!canEditPlanning && <small className="muted">
        هذه الحقول للعرض فقط حتى تُمنح صلاحية تعديل قائمة الأصناف.
      </small>}
    </div>;
  const togglePlanning = (id: number) => setExpandedItemId(current => current === id ? null : id);
  const moreButton = (row: DraftRow) =>
    <button type="button" className="item-order-draft-expand-button"
      aria-label={"إظهار أو إخفاء كمية الاحتياط وعامل الشراء للصنف " + row.item.name}
      aria-expanded={expandedItemId === row.item.id}
      title={expandedItemId === row.item.id ? "إخفاء التفاصيل" : "إظهار المزيد"}
      onClick={() => togglePlanning(row.item.id)}>⋯</button>;
  const action = (row: DraftRow) => row.item.deleted
    ? <Button size="compact" variant="secondary"
        onClick={() => drafts.setItemDeleted(row.draftId, row.item.id, false)}>إرجاع الحذف</Button>
    : <Button size="compact" variant="danger" onClick={() => {
        if (drafts.setItemDeleted(row.draftId, row.item.id, true)) selectItem(row.item.id, false);
      }}>حذف</Button>;

  return <div className="wallet-page item-order-drafts-page">
    <PageHeader title="متابعة مسودات الطلبيات"
      description="جميع أصناف المسودات المحفوظة محليًا على هذا الجهاز"
      actions={<Link className="button button-secondary"
        to={"/companies/" + companyId + "/item-options-list"}>العودة إلى قائمة الأصناف</Link>} />
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
                  disabled={!draft.items.some(item => !item.deleted)}
                  onClick={() => printDraft(draft.id)}>طباعة المسودة</Button>
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
        <Button variant="secondary" disabled={!allPrintable.length}
          onClick={() => printDraft("all")}>طباعة الكل</Button>
        <Button variant="secondary" disabled={exportingPdf || !allPrintable.length}
          onClick={() => void exportDraftPdf("all")}>
          {exportingPdf ? "جارٍ تجهيز PDF…" : "ترحيل الكل PDF"}
        </Button>
      </div>
      {draftActionNotice && <Notice>{draftActionNotice}</Notice>}
    </Card>
    <Card title={"المسودات: " + drafts.drafts.length + " — الأصناف الفعالة: " + activeCount + " — المحذوفة: " + removedCount}>
      <div className="item-order-drafts-filters">
        <label>البحث عن صنف أو اسم خيارات
          <input type="search" value={search} onChange={event => { setSearch(event.target.value); resetPage(); }}
            placeholder="اسم الصنف أو اسم الخيارات" />
        </label>
        <label>المسودة
          <select value={draftFilter} onChange={event => { setDraftFilter(event.target.value); resetPage(); }}>
            <option value="all">كل المسودات</option>
            {drafts.drafts.map(draft => <option key={draft.id} value={draft.id}>
              مسودة الطلبية {draft.id} — {draft.sourceOptionName ?? "خيارات متعددة"}
            </option>)}
          </select>
        </label>
        <label>الحالة
          <select value={status} onChange={event => { setStatus(event.target.value); resetPage(); }}>
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
              setSortDir("asc"); resetPage();
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
          </select>
        </label>
        <Button variant="secondary" disabled={!sortKey}
          onClick={() => {setSortDir(value => value === "asc" ? "desc" : "asc"); resetPage();}}>
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
        <Button type="button" variant="secondary" disabled={!visibleActiveIds.length}
          onClick={() => selectVisible(!allVisibleSelected)}>
          {allVisibleSelected ? "إلغاء تحديد الظاهر" : "تحديد الظاهر"}
        </Button>
        <Button type="button" variant="secondary" disabled={!selectedIds.size}
          onClick={() => setSelectedIds(new Set())}>إلغاء التحديد</Button>
        <Button type="button" variant="danger" disabled={!selectedActiveIds.length || groupBusy}
          onClick={deleteSelected}>حذف المحدد ({selectedActiveIds.length})</Button>
      </div>
      {metricsLoading && <small className="muted" role="status">جارٍ تحديث مؤشرات المبيعات والسعر والقيمة…</small>}
      {metricsError && <Notice tone="error">تعذر تحميل مؤشرات الأصناف: {errorMessage(metricsError)}</Notice>}
      {!drafts.drafts.length && <Notice>لا توجد مسودات محفوظة على هذا الجهاز حاليًا. أنشئ مسودة أو اختر تجميعًا أعلاه.</Notice>}
      {!!drafts.drafts.length && <div className="table-scroll item-order-drafts-table-scroll" role="region"
        aria-label="قائمة أصناف جميع المسودات">
        <table className="item-order-drafts-table">
          <thead><tr>
            <th className="item-order-drafts-select-col">
              <input type="checkbox" aria-label="اختيار جميع أصناف الصفحة غير المحذوفة"
                disabled={!visibleActiveIds.length} checked={allVisibleSelected}
                onChange={event => selectVisible(event.target.checked)} />
            </th>
            {sortHeader("quantity", "الكمية المطلوبة (و1)")}
            {sortHeader("name", "اسم الصنف")}
            <th scope="col" aria-label="إظهار التفاصيل">⋯</th>
            {sortHeader("stock", "المتوفر دون المرتجعات (و1)")}
            {sortHeader("sold", "الكمية المباعة في شهر (و1)")}
            {sortHeader("month", "المبيعات مرات في شهر")}
            {sortHeader("year", "المبيعات مرات في سنة")}
            {sortHeader("price", "سعر الشراء")}
            {sortHeader("value", "قيمة المطلوب")}
            <th>الإجراء</th>
            {sortHeader("option", "اسم الخيارات")}
          </tr></thead>
          <tbody>{visible.map(row => {
            const info = metricsById.get(row.item.id);
            return <Fragment key={row.draftId + ":" + row.item.id}>
              <tr className={row.item.deleted ? "item-order-draft-deleted" : undefined}>
              <td data-label="اختيار">
                <input type="checkbox" aria-label={"اختيار " + row.item.name}
                  disabled={!!row.item.deleted} checked={!row.item.deleted && selectedIds.has(row.item.id)}
                  onChange={event => selectItem(row.item.id, event.target.checked)} />
              </td>
              <td data-label="الكمية المطلوبة">
                <DraftQuantityInput item={row.item} factor={info?.purchaseFactor}
                  onSave={quantity => drafts.updateItemQuantity(row.draftId, row.item.id, quantity)} />
              </td>
              <td data-label="اسم الصنف">
                <Link to={"/companies/" + companyId + "/items/" + row.item.id}>{row.item.name}</Link>
                {row.item.deleted && <strong className="item-order-deleted-label"> محذوف</strong>}
              </td>
              <td data-label="إظهار التفاصيل">{moreButton(row)}</td>
              <td data-label="المتوفر دون المرتجعات">
                <span className="item-order-drafts-stock-quantity"><bdi>{formatStockSaleQuantity(info?.availableUnit1)}</bdi></span>
              </td>
              <td data-label="المباع في شهر">
                <span className="item-order-drafts-sold-quantity"><bdi>{formatStockSaleQuantity(info?.saleQuantityMonth)}</bdi></span>
              </td>
              <td data-label="مرات شهر"><bdi>{formatNumber(info?.saleTimesMonth)}</bdi></td>
              <td data-label="مرات سنة"><bdi>{formatNumber(info?.saleTimesYear)}</bdi></td>
              <td data-label="سعر الشراء"><bdi>{formatNumber(info?.purchasePrice)}</bdi></td>
              <td data-label="قيمة المطلوب"><bdi>{formatNumber(info?.requiredPurchaseValue)}</bdi></td>
              <td data-label="الإجراء">
                <div className="item-order-draft-inline-actions">{action(row)}</div>
              </td>
              <td data-label="اسم الخيارات" title={"مسودة " + row.draftId}>{optionName(row)}</td>
              </tr>
              {expandedItemId === row.item.id && <tr className="item-order-draft-expanded-row">
                <td colSpan={12}>{planningControls(row, info)}</td>
              </tr>}
            </Fragment>;
          })}
          {!filtered.length && <tr><td colSpan={12}>لا توجد أصناف مطابقة للبحث.</td></tr>}
          </tbody>
        </table>
      </div>}
      {!!drafts.drafts.length && <div className="item-order-drafts-mobile-list" aria-label="متابعة الأصناف على الهاتف">
        {visible.map(row => {
          const info = metricsById.get(row.item.id);
          return <article className={"item-order-drafts-mobile-card" +
            (row.item.deleted ? " item-order-draft-deleted" : "")}
            key={row.draftId + ":" + row.item.id}>
            <div className="item-order-drafts-mobile-top">
              <input type="checkbox" aria-label={"اختيار " + row.item.name}
                disabled={!!row.item.deleted} checked={!row.item.deleted && selectedIds.has(row.item.id)}
                onChange={event => selectItem(row.item.id, event.target.checked)} />
              <DraftQuantityInput item={row.item} factor={info?.purchaseFactor}
                onSave={quantity => drafts.updateItemQuantity(row.draftId, row.item.id, quantity)} />
              <span className="item-order-drafts-mobile-name">
                <Link to={"/companies/" + companyId + "/items/" + row.item.id}>{row.item.name}</Link>
                {row.item.deleted && <strong className="item-order-deleted-label"> محذوف</strong>}
              </span>
              {action(row)}
            </div>
            <div className="item-order-drafts-mobile-bottom" role="group"
              aria-label={"مؤشرات الصنف " + row.item.name}>
              {moreButton(row)}
              <span title="المتوفر دون مخازن المرتجعات">
                <small>المتوفر</small><bdi className="item-order-drafts-stock-quantity">{formatStockSaleQuantity(info?.availableUnit1)}</bdi>
              </span>
              <span title="الكمية المباعة في شهر">
                <small>المباع</small><bdi className="item-order-drafts-sold-quantity">{formatStockSaleQuantity(info?.saleQuantityMonth)}</bdi>
              </span>
              <span title="المبيعات مرات في شهر"><small>مرات شهر</small><bdi>{formatNumber(info?.saleTimesMonth)}</bdi></span>
              <span title="المبيعات مرات في سنة"><small>مرات سنة</small><bdi>{formatNumber(info?.saleTimesYear)}</bdi></span>
              <span title="سعر الشراء"><small>سعر الشراء</small><bdi>{formatNumber(info?.purchasePrice)}</bdi></span>
              <span title="قيمة المطلوب"><small>قيمة المطلوب</small>
                <bdi>{formatNumber(info?.requiredPurchaseValue)}</bdi></span>
              <span title={"مسودة " + row.draftId}><small>اسم الخيارات</small>{optionName(row)}</span>
            </div>
            {expandedItemId === row.item.id &&
              <div className="item-order-drafts-mobile-third-row">
                {planningControls(row, info)}
              </div>}
          </article>;
        })}
        {!filtered.length && <p className="muted">لا توجد أصناف مطابقة للبحث.</p>}
      </div>}
      {pages > 1 && <div className="form-actions item-order-drafts-pagination">
        <Button variant="secondary" disabled={currentPage <= 1}
          onClick={() => setPage(currentPage - 1)}>السابق</Button>
        <span>صفحة {currentPage} من {pages}</span>
        <Button variant="secondary" disabled={currentPage >= pages}
          onClick={() => setPage(currentPage + 1)}>التالي</Button>
      </div>}
    </Card>
    <section className="item-options-print-sheet" dir="rtl"
      aria-label="طباعة أصناف مسودات الطلبيات مع الكميات المطلوبة">
      <div className="item-options-print-columns">
        {printRows.map(item => <div className="item-options-print-row" key={item.id}>
          {!item.heading && <bdi className="item-options-print-quantity">
            {item.requiredQuantity ?? "—"}
          </bdi>}
          <span className="item-options-print-name">{item.name}</span>
        </div>)}
      </div>
    </section>
  </div>;
}
