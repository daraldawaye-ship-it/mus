import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import type { ItemOptionsPresetGroup } from "../../../../packages/contracts/src/item-options-presets.ts";
import { normalizeDigits } from "../../../../packages/contracts/src/masters.ts";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { useNumberedOrderDrafts } from "../numbered-order-drafts";
import type { OrderDraftItem } from "../numbered-order-drafts-core";
import { Button, Card, Notice, PageHeader } from "../ui";

type DraftRow = { draftId: number; draftOptionName?: string; item: OrderDraftItem };
type DraftMetrics = {
  itemId: number; availableUnit1: string; saleQuantityMonth: string;
  saleTimesMonth: string; saleTimesYear: string; purchaseFactor: number;
  purchasePrice: string; purchaseCurrencyCode: string; requiredPurchaseValue: string | null;
};
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
    {lot && !item.deleted && <small className="muted">عامل الشراء: {factor}</small>}
    {error && !item.deleted && <small role="alert">{error}</small>}
  </div>;
}

export function ItemOrderDraftsPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const drafts = useNumberedOrderDrafts(companyId, user?.id);
  const [search, setSearch] = useState("");
  const [draftFilter, setDraftFilter] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [selectedGroupId, setSelectedGroupId] = useState("");
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
  const pageSize = 100;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const visibleActiveIds = visible.filter(row => !row.item.deleted).map(row => row.item.id);
  const selectedActiveIds = rows.filter(row => !row.item.deleted && selectedIds.has(row.item.id))
    .map(row => row.item.id);
  const allVisibleSelected = visibleActiveIds.length > 0
    && visibleActiveIds.every(id => selectedIds.has(id));
  const resetPage = () => setPage(1);

  const requests = visible.map(row => ({
    id: row.item.id, requiredQuantity: row.item.deleted ? null : row.item.requiredQuantity ?? null,
  }));
  const requestKey = JSON.stringify(requests);
  const metricsQuery = useQuery({
    queryKey: ["item-order-draft-review", companyId, user?.id, requestKey],
    queryFn: ({ signal }) => api<{ items: DraftMetrics[] }>(
      "/companies/" + companyId + "/item-options-list/draft-review",
      { method: "POST", body: { items: requests }, signal },
    ),
    enabled: !!user && !!requests.length, staleTime: 30_000,
  });
  const metricsById = new Map((metricsQuery.data?.items ?? []).map(item => [item.itemId, item]));
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
      <div className="item-order-drafts-bulk">
        <span>إجمالي الأصناف المطابقة: <bdi>{filtered.length.toLocaleString("en-US")}</bdi></span>
        <Button type="button" variant="secondary" disabled={!visibleActiveIds.length}
          onClick={() => selectVisible(!allVisibleSelected)}>
          {allVisibleSelected ? "إلغاء تحديد الظاهر" : "تحديد الظاهر"}
        </Button>
        <Button type="button" variant="secondary" disabled={!selectedIds.size}
          onClick={() => setSelectedIds(new Set())}>إلغاء التحديد</Button>
        <Button type="button" variant="danger" disabled={!selectedActiveIds.length || groupBusy}
          onClick={deleteSelected}>حذف المحدد ({selectedActiveIds.length})</Button>
      </div>
      {metricsQuery.isFetching && <small className="muted" role="status">جارٍ تحديث مؤشرات المبيعات والسعر والقيمة…</small>}
      {metricsQuery.error && <Notice tone="error">تعذر تحميل مؤشرات الأصناف: {errorMessage(metricsQuery.error)}</Notice>}
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
            <th>اسم الصنف</th><th>اسم الخيارات</th>
            <th>المتوفر دون المرتجعات (و1)</th>
            <th>الكمية المباعة في شهر (و1)</th>
            <th>المبيعات مرات في شهر</th><th>المبيعات مرات في سنة</th>
            <th>سعر الشراء</th><th>الكمية المطلوبة (و1)</th>
            <th>قيمة المطلوب</th><th>الإجراء</th>
          </tr></thead>
          <tbody>{visible.map(row => {
            const info = metricsById.get(row.item.id);
            return <tr key={row.draftId + ":" + row.item.id}
              className={row.item.deleted ? "item-order-draft-deleted" : undefined}>
              <td data-label="اختيار">
                <input type="checkbox" aria-label={"اختيار " + row.item.name}
                  disabled={!!row.item.deleted} checked={!row.item.deleted && selectedIds.has(row.item.id)}
                  onChange={event => selectItem(row.item.id, event.target.checked)} />
              </td>
              <td data-label="اسم الصنف"><Link to={"/companies/" + companyId + "/items/" + row.item.id}>{row.item.name}</Link>
                {row.item.deleted && <strong className="item-order-deleted-label"> محذوف</strong>}</td>
              <td data-label="اسم الخيارات" title={"مسودة " + row.draftId}>{optionName(row)}</td>
              <td data-label="المتوفر دون المرتجعات"><bdi>{formatNumber(info?.availableUnit1)}</bdi></td>
              <td data-label="المباع في شهر"><bdi>{formatNumber(info?.saleQuantityMonth)}</bdi></td>
              <td data-label="مرات شهر"><bdi>{formatNumber(info?.saleTimesMonth)}</bdi></td>
              <td data-label="مرات سنة"><bdi>{formatNumber(info?.saleTimesYear)}</bdi></td>
              <td data-label="سعر الشراء"><bdi>{formatNumber(info?.purchasePrice)}</bdi>
                {info && <small className="item-options-currency">{info.purchaseCurrencyCode}</small>}</td>
              <td data-label="الكمية المطلوبة"><DraftQuantityInput item={row.item}
                factor={info?.purchaseFactor}
                onSave={quantity => drafts.updateItemQuantity(row.draftId, row.item.id, quantity)} /></td>
              <td data-label="قيمة المطلوب"><bdi>{row.item.deleted ? "—" : formatNumber(info?.requiredPurchaseValue)}</bdi>
                {!row.item.deleted && info && <small className="item-options-currency">{info.purchaseCurrencyCode}</small>}</td>
              <td data-label="الإجراء">{action(row)}</td>
            </tr>;
          })}
          {!filtered.length && <tr><td colSpan={11}>لا توجد أصناف مطابقة للبحث.</td></tr>}
          </tbody>
        </table>
      </div>}
      {pages > 1 && <div className="form-actions item-order-drafts-pagination">
        <Button variant="secondary" disabled={currentPage <= 1}
          onClick={() => setPage(currentPage - 1)}>السابق</Button>
        <span>صفحة {currentPage} من {pages}</span>
        <Button variant="secondary" disabled={currentPage >= pages}
          onClick={() => setPage(currentPage + 1)}>التالي</Button>
      </div>}
    </Card>
  </div>;
}
