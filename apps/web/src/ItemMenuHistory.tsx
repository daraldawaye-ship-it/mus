import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ItemCompositionPeers, Page } from "../../../packages/contracts/src/index";
import { stockMovementKindLabels, type StockMovement } from "../../../packages/contracts/src/inventory";
import { signedStockMovementQuantity } from "./stock-movement-display";
import { api } from "./api";

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

/** The search stays in place. The five scalable navigation-style tiles are
 * replaced by a page of ten real records; tapping the top Item tab resets them. */
export function ItemMenuHistory({
  userId, companyId, itemId, itemName, resetKey, onEditItem, onQuickAction, canCreateMemo,
}: {
  userId: number;
  companyId: number;
  itemId: number | null;
  itemName: string | null;
  resetKey: number;
  onEditItem: (itemId: number) => void;
  onQuickAction: (action: ItemMenuQuickAction, itemId: number, itemName: string) => void;
  canCreateMemo: boolean;
}) {
  const [view, setView] = useState<ItemMenuView | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => { setView(null); setPage(1); }, [resetKey]);
  useEffect(() => { setPage(1); }, [itemId, view]);

  const history = useQuery<HistoryResult>({
    queryKey: ["avatar-item-history", userId, companyId, itemId, view, page],
    queryFn: ({ signal }) => api<HistoryResult>(
      `/companies/${companyId}/item-history/${itemId}?${new URLSearchParams({
        type: view!, page: String(page), pageSize: "10",
      })}`, { signal }),
    enabled: !!itemId && !!view && view !== "alternatives" && view !== "movement",
    staleTime: 10000,
  });
  const movements = useQuery<Page<StockMovement>>({
    queryKey: ["avatar-item-stock-movements", userId, companyId, itemId, page],
    queryFn: ({signal})=>api<Page<StockMovement>>(
      `/companies/${companyId}/stock-movements?${new URLSearchParams({
        itemId: String(itemId), page: String(page), pageSize: "10",
        sort: "documentDate:desc,id:desc",
      })}`, {signal}),
    enabled: !!itemId && view === "movement",
    staleTime: 10000,
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
          <button type="button" key={action.key} className="user-menu-tile"
            onClick={() => { setPage(1); setView(action.key); }}>
            <span>{action.label}</span>
          </button>
        ))}
        <button type="button" className="user-menu-tile"
          disabled={!itemId}
          title={itemId ? `فتح كرت الصنف: ${itemName ?? ""}` : "اختر صنفًا من البحث أولًا"}
          onClick={() => { if (itemId) onEditItem(itemId); }}>
          <span>كرت الصنف</span>
        </button>
        {([
          ["adjustment", "تسوية الصنف"],
          ["transfer", "مناقلة الصنف"],
          ["memo", "إرسال مذكرة بالصنف"],
          ["memo-return", "إرسال مذكرة مرتجع"],
        ] as const).map(([key,label]) => (
          <button type="button" className="user-menu-tile" key={key}
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

  const selectedLabel = actions.find(action => action.key === view)?.label;
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
      <div className="user-menu-item-history-heading">
        <strong>{selectedLabel}</strong>
        <span title={itemName ?? undefined}>{itemName}</span>
      </div>
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
          )) : isMovement ? movements.data?.items.map(row => (
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
              <span>الصفحة {page}</span>
              {hasMore && (
                <button type="button" disabled={fetching} onClick={() => setPage(p => p + 1)}>
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
