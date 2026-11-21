import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ItemCompositionPeers, Page } from "../../../packages/contracts/src/index";
import { stockMovementKindLabels, type StockMovement } from "../../../packages/contracts/src/inventory";
import { formatWorkPanelMovementQuantity, signedStockMovementQuantity, workPanelMovementKindLabels, workPanelPurchaseSupplier } from "./stock-movement-display";
import { api } from "./api";
import { connectionSnapshot, subscribeConnection } from "./connection-mode";
import { formatWholeMoney } from "./format-money";
import ScrollableTableCell from "./ScrollableTableCell";

type ItemMenuView = "movement" | "purchase" | "sale" | "adjustment" | "transfer" | "alternatives";
export type ItemMenuQuickAction = "adjustment" | "transfer" | "memo" | "memo-return";
type HistoryRow = {
  lineId: number;
  documentId: number;
  documentDate: string;
  partyName?: string;
  description?: string;
  quantityFirstUnit: string;
  unitPriceFirstUnit?: string;
  currencyCode?: string;
};
type HistoryResult = { items: HistoryRow[]; hasMore: boolean };
const actions: { key: ItemMenuView; label: string }[] = [
  { key: "movement", label: "حركة الصنف" },
  { key: "purchase", label: "مشتريات" },
  { key: "sale", label: "مبيعات" },
  { key: "adjustment", label: "تسويات" },
  { key: "transfer", label: "مناقلات" },
  { key: "alternatives", label: "البدائل" },
];

type MovementInvoiceDetail = {
  movementId: number;
  invoiceLineId: number;
  invoiceId: number;
  partyName: string | null;
  postedUnitPrice: string | null;
  firstUnitMultiplier: string | null;
  invoiceNet: string | null;
};

function WorkPanelMovementTable({ rows, invoiceDetails }: {
  rows: StockMovement[];
  invoiceDetails: MovementInvoiceDetail[];
}) {
  if (!rows.length) return null;
  const invoices = new Map(invoiceDetails.map(detail => [detail.movementId, detail]));
  return (
    <div className="invoice-item-options-scroll work-panel-movement-scroll" role="region" tabIndex={0}
      aria-label="جدول حركات الصنف">
      <table className="invoice-item-options-table invoice-item-history-sales-table work-panel-movement-table" dir="rtl">
        <thead><tr>
          <th scope="col">النوع</th>
          <th scope="col" className="invoice-item-options-number" title="الكمية بالوحدة الأولى">الكمية</th>
          <th scope="col" className="invoice-item-options-number" title="سعر الوحدة المستخدمة في سطر الفاتورة">السعر</th>
          <th scope="col">التاريخ</th>
          <th scope="col" className="invoice-item-options-number" title="صافي الفاتورة كاملة بعد الخصم، لا صافي الصنف">الصافي</th>
        </tr></thead>
        <tbody>{rows.map(row => {
          const detail = invoices.get(row.id);
          const invoice = detail?.invoiceLineId === row.invoiceLineId && detail?.invoiceId === row.invoiceId ? detail : undefined;
          const quantity = formatWorkPanelMovementQuantity(row.quantitySmallest, invoice?.firstUnitMultiplier);
          const purchase = row.kind === "purchase" || row.kind === "purchase_return";
          const sale = row.kind === "sale" || row.kind === "sales_return";
          const counterparty = purchase ? (invoice?.partyName?.trim() || workPanelPurchaseSupplier(row)) :
            sale ? invoice?.partyName?.trim() : null;
          const money = (value: string | null | undefined, description: string) => (
            <td className="invoice-item-options-number"
              title={value != null ? `${description} ${value}` : description}>
              <bdi>{formatWholeMoney(value)}</bdi>
            </td>
          );
          const reference = !row.invoiceId && row.operationId ? `عملية ${row.operationId}` : null;
          const details = [counterparty, row.createdByName, row.doctorName, row.notes]
            .flatMap(value => value?.trim() ? [value.trim().replace(/\s+/g, " ")] : []);
          return (
            <Fragment key={row.id}>
              <tr>
                <td title={stockMovementKindLabels[row.kind]}>
                  <span className="work-panel-movement-kind" data-movement-kind={row.kind}>
                    <span className="work-panel-movement-kind-dot" aria-hidden="true" />
                    <span className="work-panel-movement-kind-label">{workPanelMovementKindLabels[row.kind]}</span>
                  </span>
                </td>
                <td className="invoice-item-options-number" title={quantity.exact ?? "لا يتوفر معامل تاريخي موثّق للتحويل إلى الوحدة الأولى"}>
                  <bdi dir="ltr" data-work-panel-quantity={quantity.direction}>{quantity.text}</bdi>
                </td>
                {money(invoice?.postedUnitPrice, "سعر الوحدة حسب الفاتورة:")}
                <td dir="ltr" title={row.documentDate}>{row.documentDate}</td>
                {money(invoice?.invoiceNet, "صافي الفاتورة:")}
              </tr>
              <tr className="invoice-item-history-details-row">
                <td colSpan={5}>
                  <ScrollableTableCell className="work-panel-movement-details">
                    <span className="work-panel-movement-detail-line">
                      {reference && <bdi>{reference}</bdi>}
                      {details.map((value, index) => <bdi key={index} dir="auto">({value})</bdi>)}
                      {!reference && details.length === 0 && "—"}
                    </span>
                  </ScrollableTableCell>
                </td>
              </tr>
            </Fragment>
          );
        })}</tbody>
      </table>
    </div>
  );
}

/** Reuses the existing item reports in the menu or as a fixed work-panel view. */
export function ItemMenuHistory({
  userId, companyId, itemId, itemName, resetKey = 0, fixedView, hideHeading = false, workPanelMovement = false,
  onEditItem = () => {}, onOpenComposition = () => {}, onQuickAction = () => {},
  canCreateMemo = false, canViewItemCompositions = false,
}: {
  userId: number;
  companyId: number;
  itemId: number | null;
  itemName: string | null;
  resetKey?: number;
  fixedView?: "movement" | "alternatives";
  hideHeading?: boolean;
  workPanelMovement?: boolean;
  onEditItem?: (itemId: number) => void;
  onOpenComposition?: (compositionId: number) => void;
  onQuickAction?: (action: ItemMenuQuickAction, itemId: number, itemName: string) => void;
  canCreateMemo?: boolean;
  canViewItemCompositions?: boolean;
}) {
  const [selectedView, setView] = useState<ItemMenuView | null>(null);
  const view = fixedView ?? selectedView;
  const [page, setPage] = useState(1);
  useEffect(() => { setView(null); setPage(1); }, [resetKey]);
  useEffect(() => { setPage(1); }, [itemId, view]);

  // The linked composition is read from the selected item card, never guessed
  // from its name. Only offer the shortcut to users permitted to view compositions.
  const itemCard = useQuery<{item: {id: number; compositionId: number | null}}>({
    queryKey: ["avatar-item-composition-link", userId, companyId, itemId],
    queryFn: ({signal}) => api<{item: {id: number; compositionId: number | null}}>(
      `/companies/${companyId}/items/${itemId}`, {signal}),
    enabled: !!itemId && canViewItemCompositions && !fixedView,
    staleTime: 30_000,
  });
  const compositionId = itemCard.data?.item.id === itemId
    ? itemCard.data.item.compositionId : null;

  const history = useQuery<HistoryResult>({
    queryKey: ["avatar-item-history", userId, companyId, itemId, view, page],
    queryFn: ({ signal }) => api<HistoryResult>(
      `/companies/${companyId}/item-history/${itemId}?${new URLSearchParams({
        type: view!, page: String(page), pageSize: "10",
      })}`, { signal }),
    enabled: !!itemId && !!view && view !== "alternatives" && view !== "movement",
    staleTime: 10000,
  });
  const connection = useSyncExternalStore(subscribeConnection, connectionSnapshot);
  const includeMovementNotes = workPanelMovement && connection === "online";
  const movements = useQuery<Page<StockMovement>>({
    queryKey: ["avatar-item-stock-movements", userId, companyId, itemId, page, includeMovementNotes],
    queryFn: ({signal})=>api<Page<StockMovement>>(
      `/companies/${companyId}/stock-movements?${new URLSearchParams({
        itemId: String(itemId), page: String(page), pageSize: "10",
        sort: "documentDate:desc,id:desc",
        ...(includeMovementNotes ? { includeNotes: "1" } : {}),
      })}`, {signal}),
    enabled: !!itemId && view === "movement",
    staleTime: 10000,
  });
  const invoiceMovementIds = workPanelMovement && view === "movement"
    ? (movements.data?.items ?? [])
      .filter(row => row.invoiceId && row.invoiceLineId &&
        ["purchase", "purchase_return", "sale", "sales_return"].includes(row.kind))
      .map(row => row.id).join(",")
    : "";
  const movementInvoices = useQuery<{ items: MovementInvoiceDetail[] }>({
    queryKey: ["work-panel-movement-invoices", userId, companyId, itemId, invoiceMovementIds],
    queryFn: ({signal}) => api<{items: MovementInvoiceDetail[]}>(
      `/companies/${companyId}/item-history/${itemId}/movement-invoices?movementIds=${invoiceMovementIds}`, {signal}),
    enabled: !!itemId && !!invoiceMovementIds,
    staleTime: 10000,
    retry: false,
  });
  const alternatives = useQuery<{ peers: ItemCompositionPeers }>({
    queryKey: ["avatar-item-alternatives", userId, companyId, itemId, page],
    queryFn: ({ signal }) => api<{ peers: ItemCompositionPeers }>(
      `/companies/${companyId}/items/${itemId}/composition-peers?page=${page}&pageSize=10`,
      { signal }),
    enabled: !!itemId && view === "alternatives",
    staleTime: 10000,
  });

  if (!view) {
    return (
      <div className="user-menu-grid user-menu-item-actions" aria-label="خيارات الصنف">
        {actions.map(action => (
          <button type="button" key={action.key} className="user-menu-tile" data-operator-action="entity.open" data-operator-detail={`menu.item.${action.key}`}
            onClick={() => { setPage(1); setView(action.key); }}>
            <span>{action.label}</span>
          </button>
        ))}
        <button type="button" className="user-menu-tile"
          disabled={!itemId}
          data-operator-action="entity.open" data-operator-detail="menu.item.card"
          title={itemId ? `فتح كرت الصنف: ${itemName ?? ""}` : "اختر صنفًا من البحث أولًا"}
          onClick={() => { if (itemId) onEditItem(itemId); }}>
          <span>كرت الصنف</span>
        </button>
        {canViewItemCompositions && !!compositionId && (
          <button type="button" className="user-menu-tile"
            data-operator-action="entity.open" data-operator-detail="menu.item.composition-card"
            title={`فتح كرت تركيب الصنف: ${itemName ?? ""}`}
            onClick={() => onOpenComposition(compositionId)}>
            <span>كرت تركيب الصنف</span>
          </button>
        )}
        {([
          ["adjustment", "تسوية الصنف"],
          ["transfer", "مناقلة الصنف"],
          ["memo", "إرسال مذكرة بالصنف"],
          ["memo-return", "إرسال مذكرة مرتجع"],
        ] as const).map(([key,label]) => (
          <button type="button" className="user-menu-tile" key={key} data-operator-action="entity.open" data-operator-detail={`menu.item.${key}`}
            disabled={!itemId || (key.startsWith("memo") && !canCreateMemo)}
            title={!itemId ? "اختر صنفًا من البحث أولًا" :
              key.startsWith("memo") && !canCreateMemo ? "ليست لديك صلاحية إنشاء المذكرات" :
              `${label}: ${itemName ?? ""}`}
            onClick={() => {if(itemId)onQuickAction(key,itemId,itemName??`#${itemId}`);}}>
            <span>{label}</span>
          </button>
        ))}

      </div>
    );
  }

  const selectedLabel = fixedView === "alternatives"
    ? "بدائل الصنف" : actions.find(action => action.key === view)?.label;
  const isAlternatives = view === "alternatives";
  const isMovement = view === "movement";
  const isInvoice = view === "purchase" || view === "sale";
  const waiting = isAlternatives ? alternatives.isPending :
    isMovement ? movements.isPending : history.isPending;
  const failed = isAlternatives ? alternatives.isError :
    isMovement ? movements.isError : history.isError;
  const peers = alternatives.data?.peers;
  const rows = isAlternatives ? peers?.peers :
    isMovement ? movements.data?.items : history.data?.items;
  const hasMore = isAlternatives
    ? !!peers && page * peers.pageSize < peers.total
    : isMovement
      ? !!movements.data && page * movements.data.pageSize < movements.data.total
      : !!history.data?.hasMore;
  const fetching = isAlternatives ? alternatives.isFetching :
    isMovement ? movements.isFetching : history.isFetching;
  return (
    <div className="user-menu-item-history" aria-live="polite">
      {!hideHeading && (
        <div className="user-menu-item-history-heading">
          <strong>{selectedLabel}</strong>
          <span title={itemName ?? undefined}>{itemName}</span>
        </div>
      )}
      {!itemId ? <p className="user-menu-entity-hint">اختر صنفًا من البحث أولًا.</p> : (
        <>
          {waiting && <p className="user-menu-entity-hint">جارٍ تحميل الحركات…</p>}
          {failed && <p className="user-menu-entity-hint">تعذر تحميل البيانات؛ تحقق من صلاحيات عرض الفواتير أو المخزون أو الأصناف.</p>}
          {isAlternatives && peers && !peers.composition &&
            <p className="user-menu-entity-hint">لا يوجد تركيب مرتبط بهذا الصنف.</p>}
          {isAlternatives && peers?.composition && (
            <p className="user-menu-entity-hint">
              {peers.relation === "identicalAlternative" ? "بدائل مطابقة بحسب كرت التركيب" :
               peers.relation === "nonInterchangeable" ? "تنبيه: غير قابلة للتبديل" :
               "أصناف تشترك في التركيب دون اعتماد التبديل"}
            </p>
          )}
          {!waiting && !failed && rows?.length === 0 &&
            <p className="user-menu-entity-hint">لا توجد نتائج لهذا الصنف.</p>}
          {isAlternatives ? peers?.peers.map(peer => (
            <div key={peer.id} className="user-menu-item-history-row">
              <strong title={peer.name}>{peer.name}</strong>
              <div className="user-menu-item-history-meta">
                <span>{peer.code}</span>
                {peers.canViewStock && peer.stockSmallest !== null &&
                  <span>الرصيد: <bdi>{peer.stockSmallest}</bdi> {peer.smallestUnitName}</span>}
              </div>
            </div>
          )) : isMovement && workPanelMovement ? (
            <WorkPanelMovementTable rows={movements.data?.items ?? []} invoiceDetails={movementInvoices.data?.items ?? []} />
          ) : isMovement ? movements.data?.items.map(row => (
            <div key={row.id} className="user-menu-item-history-row">
              <div className="user-menu-item-history-meta">
                <span dir="ltr">{row.documentDate}</span>
                <strong>{stockMovementKindLabels[row.kind]}</strong>
                <span>الكمية (أصغر جزء): <bdi dir="ltr">{signedStockMovementQuantity(row.quantitySmallest)}</bdi></span>
              </div>
              <div className="user-menu-item-history-meta">
                <span title={row.locationName}>{row.locationName}</span>
                <span>{row.invoiceId ? `فاتورة ${row.invoiceId}` :
                  row.operationId ? `عملية ${row.operationId}` : "حركة مخزون"}</span>
              </div>
            </div>
          )) : history.data?.items.map(row => (
            <div key={row.lineId} className="user-menu-item-history-row">
              <div className="user-menu-item-history-meta">
                <span dir="ltr">{row.documentDate}</span>
                <span>الكمية (و1): <bdi>{row.quantityFirstUnit}</bdi></span>
              </div>
              <div className="user-menu-item-history-meta">
                <span title={isInvoice ? row.partyName : row.description}>
                  {isInvoice ? (row.partyName || "غير محدد") : (row.description || "—")}
                </span>
                {isInvoice && <span>السعر: <bdi>{row.unitPriceFirstUnit ?? "—"}</bdi> {row.currencyCode || ""}</span>}
              </div>
            </div>
          ))}
          {isMovement && itemId && !waiting && !failed && (
            <Link to={`/companies/${companyId}/stock-movements?itemId=${itemId}`}
              className="user-menu-item-history-more">عرض جميع حركات الصنف</Link>
          )}
          {(page > 1 || hasMore) && !waiting && !failed && (
            <div className="user-menu-item-history-pager">
              {fixedView && page > 1 && (
                <button type="button" data-operator-action="entity.open" data-operator-detail="menu.previous" disabled={fetching} onClick={() => setPage(p => p - 1)}>
                  السابق
                </button>
              )}
              <span>الصفحة {page}</span>
              {hasMore && (
                <button type="button" data-operator-action="entity.open" data-operator-detail="menu.next" disabled={fetching} onClick={() => setPage(p => p + 1)}>
                  المزيد
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
