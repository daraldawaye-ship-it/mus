import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ItemCompositionPeers, Page } from "../../../packages/contracts/src/index";
import { stockMovementKindLabels, type StockMovement } from "../../../packages/contracts/src/inventory";
import { formatWorkPanelMovementQuantity, signedStockMovementQuantity, workPanelMovementKindLabels, workPanelPurchaseSupplier } from "./stock-movement-display";
import { api } from "./api";
import { connectionSnapshot, subscribeConnection } from "./connection-mode";
import { formatWholeMoney } from "./format-money";
import ScrollableTableCell from "./ScrollableTableCell";
import "./work-panel-alternatives.css";
import { formatStockSaleQuantity } from "./order-draft-quantities";

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

type StaffDockMovement={
  id:number; kind:"sale"|"sales_return"|"purchase"|"purchase_return";
  documentDate:string;quantitySmallest:string;postedUnitPrice:string|null;firstUnitMultiplier:string|null;
};

function StaffWorkPanelMovementTable({rows,footer,purchaseOnly}:{
  rows:StaffDockMovement[];footer?:ReactNode;purchaseOnly:boolean;
}){
  return <div className="invoice-item-options-scroll work-panel-movement-scroll" role="region" tabIndex={0}
    aria-label={purchaseOnly?"جدول مشتريات الصنف":"جدول حركات بيع وشراء الصنف"}>
    {!!rows.length&&<table className="invoice-item-options-table invoice-item-history-sales-table work-panel-movement-table work-panel-movement-staff" dir="rtl">
      <thead><tr><th scope="col">النوع</th><th scope="col">الكمية</th><th scope="col">السعر</th><th scope="col">التاريخ</th></tr></thead>
      <tbody>{rows.map(row=>{
        const quantity=formatWorkPanelMovementQuantity(row.quantitySmallest,row.firstUnitMultiplier);
        return <tr key={row.id}>
          <td><ScrollableTableCell><span className="work-panel-movement-kind" data-movement-kind={row.kind}>
            <span className="work-panel-movement-kind-dot" aria-hidden="true" />{workPanelMovementKindLabels[row.kind]}
          </span></ScrollableTableCell></td>
          <td className="invoice-item-options-number" title={quantity.exact??"لا يتوفر معامل تاريخي موثّق للتحويل إلى الوحدة الأولى"}>
            <ScrollableTableCell><bdi dir="ltr" data-work-panel-quantity={quantity.direction}>{quantity.text}</bdi></ScrollableTableCell>
          </td>
          <td className="invoice-item-options-number" title={row.postedUnitPrice??undefined}><ScrollableTableCell><bdi>{formatWholeMoney(row.postedUnitPrice)}</bdi></ScrollableTableCell></td>
          <td><ScrollableTableCell><bdi dir="ltr">{row.documentDate}</bdi></ScrollableTableCell></td>
        </tr>;
      })}</tbody>
    </table>}
    {footer&&<div className="work-panel-movement-footer">{footer}</div>}
  </div>;
}

function WorkPanelMovementTable({ rows, invoiceDetails, footer }: {
  rows: StockMovement[];
  invoiceDetails: MovementInvoiceDetail[];
  footer?: ReactNode;
}) {
  if (!rows.length && !footer) return null;
  const invoices = new Map(invoiceDetails.map(detail => [detail.movementId, detail]));
  return (
    <div className="invoice-item-options-scroll work-panel-movement-scroll" role="region" tabIndex={0}
      aria-label="جدول حركات الصنف">
      {rows.length > 0 && <table className="invoice-item-options-table invoice-item-history-sales-table work-panel-movement-table" dir="rtl">
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
              <ScrollableTableCell><bdi>{formatWholeMoney(value)}</bdi></ScrollableTableCell>
            </td>
          );
          const reference = !row.invoiceId && row.operationId ? `عملية ${row.operationId}` : null;
          const details = [counterparty, row.createdByName, row.doctorName, row.notes]
            .flatMap(value => value?.trim() ? [value.trim().replace(/\s+/g, " ")] : []);
          return (
            <Fragment key={row.id}>
              <tr>
                <td title={stockMovementKindLabels[row.kind]}>
                  <ScrollableTableCell><span className="work-panel-movement-kind" data-movement-kind={row.kind}>
                    <span className="work-panel-movement-kind-dot" aria-hidden="true" />
                    <span>{workPanelMovementKindLabels[row.kind]}</span>
                  </span></ScrollableTableCell>
                </td>
                <td className="invoice-item-options-number" title={quantity.exact ?? "لا يتوفر معامل تاريخي موثّق للتحويل إلى الوحدة الأولى"}>
                  <ScrollableTableCell><bdi dir="ltr" data-work-panel-quantity={quantity.direction}>{quantity.text}</bdi></ScrollableTableCell>
                </td>
                {money(invoice?.postedUnitPrice, "سعر الوحدة حسب الفاتورة:")}
                <td title={row.documentDate}><ScrollableTableCell><bdi dir="ltr">{row.documentDate}</bdi></ScrollableTableCell></td>
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
      </table>}
      {footer && <div className="work-panel-movement-footer">{footer}</div>}
    </div>
  );
}

function WorkPanelAlternativesTable({result}:{result:ItemCompositionPeers}) {
  if (!result.peers.length) return null;
  return <div className="invoice-item-options-scroll work-panel-movement-scroll work-panel-alternatives-scroll" tabIndex={0} role="region" aria-label="جدول بدائل الصنف">
    <table dir="rtl">
      <thead><tr><th scope="col">البدائل</th><th scope="col">الكمية</th><th scope="col" aria-label="صافي الكمية المباعة في شهر">المباع</th></tr></thead>
      <tbody>{result.peers.map(peer=>{
        const quantity = result.canViewStock && peer.stockAvailableSmallest != null
          && Number.isSafeInteger(peer.factor2) && peer.factor2>0
          && Number.isSafeInteger(peer.factor3) && peer.factor3>0
          ? formatWorkPanelMovementQuantity(
              peer.stockAvailableSmallest,(BigInt(peer.factor2)*BigInt(peer.factor3)).toString(),
            ).text.replace(/^\+/,"")
          : "—";
        return <tr key={peer.id}>
          <td><span title={peer.name} dir="auto">{peer.name}</span></td>
          <td><bdi dir="ltr">{quantity}</bdi></td>
          <td><bdi dir="ltr">{result.canViewMonthlySales?formatStockSaleQuantity(peer.saleQuantityMonth):"—"}</bdi></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

/** Reuses the existing item reports in the menu or as a fixed work-panel view. */
export function ItemMenuHistory({
  userId, companyId, itemId, itemName, resetKey = 0, fixedView, hideHeading = false, workPanelMovement = false, purchaseOnly = false, staffDockMovement=false, allowMovementInvoiceDetails = true,
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
  purchaseOnly?: boolean;
  staffDockMovement?:boolean;
  allowMovementInvoiceDetails?: boolean;
  onEditItem?: (itemId: number) => void;
  onOpenComposition?: (compositionId: number) => void;
  onQuickAction?: (action: ItemMenuQuickAction, itemId: number, itemName: string) => void;
  canCreateMemo?: boolean;
  canViewItemCompositions?: boolean;
}) {
  const [selectedView, setView] = useState<ItemMenuView | null>(null);
  const view = fixedView ?? selectedView;
  const [page, setPage] = useState(1);
  const [movementFrom, setMovementFrom] = useState("");
  const [movementTo, setMovementTo] = useState("");
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
  const includeMovementNotes = !staffDockMovement && workPanelMovement && connection === "online";
  const movementDateFrom = workPanelMovement ? movementFrom : "";
  const movementDateTo = workPanelMovement ? movementTo : "";
  const invalidMovementDates = !!movementDateFrom && !!movementDateTo && movementDateFrom > movementDateTo;
  const movements = useQuery<Page<StockMovement>>({
    queryKey: ["avatar-item-stock-movements", userId, companyId, itemId, page, includeMovementNotes, movementDateFrom, movementDateTo, purchaseOnly],
    queryFn: ({signal})=>api<Page<StockMovement>>(
      `/companies/${companyId}/stock-movements?${new URLSearchParams({
        itemId: String(itemId), page: String(page), pageSize: "10",
        sort: "documentDate:desc,id:desc",
        ...(includeMovementNotes ? { includeNotes: "1" } : {}),
        ...(purchaseOnly ? { purchaseOnly: "1" } : {}),
        ...(movementDateFrom ? { dateFrom: movementDateFrom } : {}),
        ...(movementDateTo ? { dateTo: movementDateTo } : {}),
      })}`, {signal}),
    enabled: !staffDockMovement && !!itemId && view === "movement" && !invalidMovementDates,
    staleTime: 10000,
  });
  const staffMovement=useQuery<{items:StaffDockMovement[];hasMore:boolean}>({
    queryKey:["staff-work-panel-movement",userId,companyId,itemId,page,purchaseOnly,movementDateFrom,movementDateTo],
    queryFn:({signal})=>api(`/companies/${companyId}/work-panel-items/${itemId}/movements?${new URLSearchParams({
      page:String(page),...(purchaseOnly?{purchaseOnly:"1"}:{}),
      ...(movementDateFrom?{dateFrom:movementDateFrom}:{}),...(movementDateTo?{dateTo:movementDateTo}:{}),
    })}`,{signal}),
    enabled:staffDockMovement&&!!itemId&&view==="movement"&&!invalidMovementDates,
    staleTime:10_000,gcTime:0,retry:false,
  });
  const movementState=staffDockMovement?staffMovement:movements;
  const invoiceMovementIds = !staffDockMovement && allowMovementInvoiceDetails && workPanelMovement && view === "movement"
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
    queryKey: ["avatar-item-alternatives", userId, companyId, itemId, page, fixedView === "alternatives"],
    queryFn: ({ signal }) => api<{ peers: ItemCompositionPeers }>(
      `/companies/${companyId}/items/${itemId}/composition-peers?page=${page}&pageSize=10${fixedView==="alternatives"?"&workPanel=1":""}`,
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
  const dockAlternatives = fixedView === "alternatives";
  const isMovement = view === "movement";
  const isInvoice = view === "purchase" || view === "sale";
  const waiting = isAlternatives ? alternatives.isPending :
    isMovement ? movementState.isPending : history.isPending;
  const failed = isAlternatives ? alternatives.isError :
    isMovement ? movementState.isError : history.isError;
  const peers = alternatives.data?.peers;
  const rows = isAlternatives ? peers?.peers :
    isMovement ? movementState.data?.items : history.data?.items;
  const hasMore = isAlternatives
    ? !!peers && page * peers.pageSize < peers.total
    : isMovement
      ? staffDockMovement?!!staffMovement.data?.hasMore:!!movements.data && page * movements.data.pageSize < movements.data.total
      : !!history.data?.hasMore;
  const fetching = isAlternatives ? alternatives.isFetching :
    isMovement ? movementState.isFetching : history.isFetching;
  const inlineMovement = isMovement && workPanelMovement;
  const controls = (<>
    {isMovement && !staffDockMovement && !purchaseOnly && itemId && !waiting && !failed && (
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
  </>);
  return (
    <div className="user-menu-item-history" aria-live="polite">
      {!hideHeading && !dockAlternatives && (
        <div className="user-menu-item-history-heading">
          <strong>{selectedLabel}</strong>
          <span title={itemName ?? undefined}>{itemName}</span>
        </div>
      )}
      {!itemId ? <p className="user-menu-entity-hint">اختر صنفًا من البحث أولًا.</p> : (
        <>
          {isMovement && workPanelMovement && (
            <div className="work-panel-movement-date-filters work-panel-date-range" role="group" aria-label="فترة حركة الصنف">
              <label>من
                <input type="date" aria-label="بداية فترة حركة الصنف" value={movementFrom} onChange={event => {
                  setMovementFrom(event.currentTarget.value);
                  setPage(1);
                }} />
              </label>
              <label>إلى
                <input type="date" aria-label="نهاية فترة حركة الصنف" value={movementTo} onChange={event => {
                  setMovementTo(event.currentTarget.value);
                  setPage(1);
                }} />
              </label>
            </div>
          )}
          {isMovement && invalidMovementDates &&
            <p className="user-menu-entity-hint" role="alert">بداية الفترة يجب ألا تكون بعد نهايتها.</p>}
          {waiting && !(isMovement && invalidMovementDates) &&
            <p className="user-menu-entity-hint">جارٍ تحميل الحركات…</p>}
          {failed && <p className="user-menu-entity-hint">{staffDockMovement?"تعذّر تحميل حركة الصنف. أعد المحاولة.":"تعذر تحميل البيانات؛ تحقق من صلاحيات عرض الفواتير أو المخزون أو الأصناف."}</p>}
          {isAlternatives && peers && !peers.composition &&
            <p className="user-menu-entity-hint">لا يوجد تركيب مرتبط بهذا الصنف.</p>}
          {isAlternatives && peers?.composition && (!dockAlternatives || peers.relation !== "sameComposition") && (
            <p className="user-menu-entity-hint">
              {peers.relation === "identicalAlternative" ? "بدائل مطابقة بحسب كرت التركيب" :
               peers.relation === "nonInterchangeable" ? "تنبيه: غير قابلة للتبديل" :
               "أصناف تشترك في التركيب دون اعتماد التبديل"}
            </p>
          )}
          {!waiting && !failed && rows?.length === 0 &&
            <p className="user-menu-entity-hint">لا توجد نتائج لهذا الصنف.</p>}
          {isAlternatives ? (dockAlternatives
            ? (!failed && peers && <WorkPanelAlternativesTable result={peers} />)
            : peers?.peers.map(peer => (
            <div key={peer.id} className="user-menu-item-history-row">
              <strong title={peer.name}>{peer.name}</strong>
              <div className="user-menu-item-history-meta">
                <span>{peer.code}</span>
                {peers.canViewStock && peer.stockSmallest !== null &&
                  <span>الرصيد: <bdi>{peer.stockSmallest}</bdi> {peer.smallestUnitName}</span>}
              </div>
            </div>
          ))) : isMovement && workPanelMovement ? (
            staffDockMovement ? <StaffWorkPanelMovementTable rows={failed?[]:staffMovement.data?.items??[]} purchaseOnly={purchaseOnly}
              footer={!waiting&&!failed?controls:undefined} /> :
            <WorkPanelMovementTable key={`${itemId}:${page}:${movementDateFrom}:${movementDateTo}`}
              rows={movements.data?.items ?? []} invoiceDetails={movementInvoices.data?.items ?? []}
              footer={!waiting && !failed ? controls : undefined} />
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
          {!inlineMovement && controls}
        </>
      )}
    </div>
  );
}
