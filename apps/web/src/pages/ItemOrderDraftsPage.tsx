import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { useSession } from "../api";
import { useNumberedOrderDrafts } from "../numbered-order-drafts";
import type { OrderDraftItem } from "../numbered-order-drafts-core";
import { Button, Card, Notice, PageHeader } from "../ui";

type DraftRow = { draftId: number; createdAt: string; draftOptionName?: string; item: OrderDraftItem };

function DraftQuantityInput({ item, onSave }: {
  item: OrderDraftItem;
  onSave: (quantity: string) => boolean;
}) {
  const [value, setValue] = useState(item.requiredQuantity ?? "");
  const [error, setError] = useState("");
  useEffect(() => { setValue(item.requiredQuantity ?? ""); setError(""); }, [item.id, item.requiredQuantity]);
  const save = () => {
    const trimmed = value.trim();
    if (!trimmed && !item.requiredQuantity) { setError(""); return; }
    if (!/^[1-9]\d{0,15}$/.test(trimmed)) {
      setError("أدخل كمية صحيحة موجبة بالوحدة الأولى.");
      return;
    }
    if (trimmed !== item.requiredQuantity && !onSave(trimmed)) {
      setError("تعذر حفظ الكمية على هذا الجهاز.");
      return;
    }
    setError("");
    setValue(trimmed);
  };
  return <div className="order-draft-quantity-editor">
    <input aria-label={`الكمية المطلوبة للصنف ${item.name}`} inputMode="numeric"
      value={value} disabled={!!item.deleted} onChange={event => {
        setValue(event.target.value); setError("");
      }} onBlur={save} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      }} placeholder="—" />
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
  const rows = useMemo<DraftRow[]>(() => drafts.drafts.flatMap(draft =>
    draft.items.map(item => ({
      draftId: draft.id, createdAt: draft.createdAt,
      draftOptionName: draft.sourceOptionName, item,
    }))), [drafts.drafts]);
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
  const resetPage = () => setPage(1);

  const action = (row: DraftRow) =>
    row.item.deleted
      ? <Button size="compact" variant="secondary"
          onClick={() => drafts.setItemDeleted(row.draftId, row.item.id, false)}>
          إرجاع الحذف
        </Button>
      : <Button size="compact" variant="danger"
          onClick={() => drafts.setItemDeleted(row.draftId, row.item.id, true)}>
          حذف
        </Button>;
  const optionName = (row: DraftRow) =>
    row.item.sourceOptionName ?? row.draftOptionName ?? "غير مسجل (مسودة سابقة)";
  return <div className="wallet-page item-order-drafts-page">
    <PageHeader title="متابعة مسودات الطلبيات"
      description="جميع أصناف المسودات المرقمة المحفوظة محليًا على هذا الجهاز"
      actions={<Link className="button button-secondary"
        to={`/companies/${companyId}/item-options-list`}>العودة إلى قائمة الأصناف</Link>} />
    <p className="muted">يمكن تعديل الكمية المطلوبة بالوحدة الأولى. زر «حذف» يضع علامة «محذوف» فقط، ويمكن إرجاع الصنف دون فقدان بياناته. لا تدخل الأصناف المحذوفة في طباعة المسودة أو قيمة المطلوب. تنتهي المسودات تلقائيًا بعد 8 ساعات من إنشائها؛ ولا تظهر مسودات أجهزة أخرى.</p>
    {drafts.error && <Notice tone="error">{drafts.error}</Notice>}
    <Card title={`المسودات: ${drafts.drafts.length} — الأصناف الفعالة: ${activeCount} — المحذوفة: ${removedCount}`}>
      <div className="item-order-drafts-filters">
        <label>البحث عن صنف أو اسم خيارات
          <input type="search" value={search} onChange={event => {setSearch(event.target.value);resetPage();}}
            placeholder="اسم الصنف أو رمز الصنف أو اسم الخيارات" />
        </label>
        <label>المسودة
          <select value={draftFilter} onChange={event => {setDraftFilter(event.target.value);resetPage();}}>
            <option value="all">كل المسودات</option>
            {drafts.drafts.map(draft => <option key={draft.id} value={draft.id}>
              مسودة الطلبية {draft.id} — {draft.sourceOptionName ?? "خيارات متعددة"}
            </option>)}
          </select>
        </label>
        <label>الحالة
          <select value={status} onChange={event => {setStatus(event.target.value);resetPage();}}>
            <option value="all">الجميع</option>
            <option value="active">غير المحذوفة</option>
            <option value="deleted">المحذوفة</option>
          </select>
        </label>
      </div>
      <p className="muted">إجمالي الأصناف المطابقة: {filtered.length.toLocaleString("en-US")}</p>
      {!drafts.drafts.length && <Notice>لا توجد مسودات محفوظة على هذا الجهاز حاليًا. أنشئ مسودة من قائمة الأصناف.</Notice>}
      {!!drafts.drafts.length && <div className="table-scroll item-order-drafts-table-scroll" role="region"
        aria-label="قائمة أصناف جميع المسودات">
        <table className="item-order-drafts-table">
          <thead><tr>
            <th>المسودة</th><th>رمز الصنف</th><th>اسم الصنف</th><th>اسم الخيارات</th>
            <th>الكمية المطلوبة (الوحدة الأولى)</th><th>الحالة</th><th>الإجراء</th>
          </tr></thead>
          <tbody>{visible.map(row => <tr key={`${row.draftId}:${row.item.id}`}
            className={row.item.deleted ? "item-order-draft-deleted" : undefined}>
            <td data-label="المسودة">مسودة {row.draftId}</td>
            <td data-label="الرمز"><bdi>{row.item.code}</bdi></td>
            <td data-label="الصنف"><Link to={`/companies/${companyId}/items/${row.item.id}`}>{row.item.name}</Link></td>
            <td data-label="اسم الخيارات">{optionName(row)}</td>
            <td data-label="الكمية المطلوبة">
              <DraftQuantityInput item={row.item}
                onSave={quantity => drafts.updateItemQuantity(row.draftId, row.item.id, quantity)} />
            </td>
            <td data-label="الحالة">{row.item.deleted ? <strong>محذوف</strong> : "فعال"}</td>
            <td data-label="الإجراء">{action(row)}</td>
          </tr>)}
          {!filtered.length && <tr><td colSpan={7}>لا توجد أصناف مطابقة للبحث.</td></tr>}
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
