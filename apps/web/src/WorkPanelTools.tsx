import {DockAccountTools} from "./DockAccountTools";
import {dockAccountAccess} from "./dock-card-access";
import {useDockTableSelection} from "./DockTableContext";
import { WorkPanelUserSearch } from "./WorkPanelUserSearch";
import { WorkPanelPageSearch } from "./WorkPanelPageSearch";
import type { PageEntry } from "../../../packages/contracts/src/index";
import { lazy, Suspense, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { CompanyContext, User } from "../../../packages/contracts/src/index";
import { EntityMenuSearch } from "./EntityMenuSearch";
import { WorkPanelCompactCard } from "./WorkPanelCompactCard";
import { ItemMenuHistory } from "./ItemMenuHistory";
import type { InvoiceItemAction } from "./InvoiceItemActionsDropdown";
import { InvoiceItemCompositionActions,InvoiceItemCompositionEditor } from "./InvoiceItemCompositionActions";
import { canEditInvoiceItemComposition } from "./invoice-item-composition-access";
import { openItemCardSheet } from "./ItemCardBottomSheetHost";
import { api, sessionRequiresLogin, useScopeGuard } from "./api";
import { connectionSnapshot, isOfflineNow, subscribeConnection } from "./connection-mode";
import { usePageDirectory } from "./page-directory";
import { errorMessage } from "./phase2";
import { Notice } from "./ui";
import { workPanelItemActionAccess } from "./work-panel-item-action-access";
import "./pages/RaisedOptionKeys.css";

type ItemView = "movement" | "card" | "alternatives";
const itemViews: { key: ItemView; label: string }[] = [
  { key: "movement", label: "الحركة" },
  { key: "card", label: "كرت" },
  { key: "alternatives", label: "البدائل" },
];
const AdjustItem = lazy(() => import("./InvoiceItemActionSheets").then(module => ({ default: module.InvoiceItemAdjustmentSheet })));
const TransferItem = lazy(() => import("./InvoiceItemActionSheets").then(module => ({ default: module.InvoiceItemTransferSheet })));
const ReportItem = lazy(() => import("./InvoiceItemActionSheets").then(module => ({ default: module.InvoiceItemReportSheet })));

/** Company-scoped tools reuse the same recent selection and reports as the menu. */
export function WorkPanelTools({user,context,showItemTools,showAccountSearch,showPageSearch,pageEntries,pagesLoading,pagesError,currentPageLabel,currentPageRoute}:{
  user:User; context?:CompanyContext; showItemTools:boolean; showAccountSearch:boolean; showPageSearch:boolean;
  pageEntries?:PageEntry[]; pagesLoading:boolean; pagesError:boolean; currentPageLabel:string; currentPageRoute:string;
}) {
  const companyId = context?.company.id ?? null;
  const dockSelection=useDockTableSelection();
  const [views, setViews] = useState<ItemView[]>([]);
  const [editingComposition,setEditingComposition]=useState<number|null>(null);
  const [active, setActive] = useState<{ action: "adjust" | "transfer" | "report"; id: number; name: string } | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string; memoId?: number } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const initiatingRequest = useRef(false);
  const guard = useScopeGuard(`work-panel-actions:${user.id}:${companyId ?? "none"}`);
  const online = useSyncExternalStore(subscribeConnection, connectionSnapshot) === "online" &&
    !sessionRequiresLogin();
  const client = useQueryClient();
  const directory = usePageDirectory(companyId ?? undefined);
  const accountAccess=dockAccountAccess(context,pagesError?undefined:pageEntries);
  const access = workPanelItemActionAccess(context, directory.data);
  const canEditComposition=canEditInvoiceItemComposition(context,directory.data);
  const canViewCard = !!context && (context.general || context.permissions.includes("items.view")) &&
    ["company.items", "company.item-card"].every(key => {
      const page=directory.data?.find(entry=>entry.key===key);
      return !!page?.enabled && page.actionAccess.view;
    });

  function refreshInventory(itemId: number) {
    for (const key of [
      ["avatar-item-stock-movements", user.id, companyId, itemId],
      ["work-panel-movement-invoices", user.id, companyId, itemId],
      ["avatar-item-alternatives", user.id, companyId, itemId],
      ["inventory", user.id, companyId],
      ["sale-stock-preview", user.id, companyId],
    ]) void client.invalidateQueries({ queryKey: key });
  }

  async function publicRequest(item: { id: number; name: string }, scopedCompanyId: number) {
    if (initiatingRequest.current) return;
    initiatingRequest.current = true;
    setRequesting(true);
    try {
      const result = await api<{ added: boolean; pointsAwarded: string }>(
        `/companies/${scopedCompanyId}/public-requests`,
        { method: "POST", body: { itemId: item.id }, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      setNotice({
        tone: "success", message: result.added
          ? `تم تسجيل طلب الجمهور: ${item.name}${BigInt(result.pointsAwarded)>0n ? ` (+${result.pointsAwarded} نقطة)` : ""}.`
          : "طلب الجمهور لهذا الصنف مسجل مسبقًا اليوم بواسطتك؛ لم يُكرر ولم تُحتسب نقاط.",
      });
      if (result.added) {
        void client.invalidateQueries({ queryKey: ["public-requests", user.id, scopedCompanyId] });
        void client.invalidateQueries({ queryKey: ["wallet-summary", user.id, scopedCompanyId] });
      }
    } catch (cause) {
      if (guard.isCurrent()) setNotice({ tone: "error", message: errorMessage(cause) });
    } finally {
      initiatingRequest.current = false;
      if (guard.isCurrent()) setRequesting(false);
    }
  }

  function openAction(action: InvoiceItemAction, item: { id: number; name: string }) {
    if (!companyId || !access[action] || !guard.isCurrent() || isOfflineNow() || sessionRequiresLogin()) return;
    setNotice(null);
    if (action === "edit") openItemCardSheet(companyId, item.id);
    else if (action === "public-request") void publicRequest(item, companyId);
    else setActive({ action, id: item.id, name: item.name });
  }

  return (
    <div className="work-panel-tools">
      {showItemTools&&<><section className="work-panel-tool-card work-panel-item-container" aria-label="حاوية الصنف">
        <div className="work-panel-item-body">
          <EntityMenuSearch user={user} companyId={companyId} kind="item" floatingResults fieldLabel="بحث عن صنف" dockSelection={dockSelection.item}
            renderSelection={selected => (
              <>
                <div className="work-panel-item-options" role="group" aria-label="عرض بيانات الصنف">
                  <InvoiceItemCompositionActions userId={user.id} companyId={companyId??undefined}
                    itemId={selected?.id??0} allowCompositionEdit={canEditComposition}
                    openComposition={setEditingComposition}
                    itemName={selected?.name ?? "الصنف"} disabled={!selected || !companyId || !online}
                    canPublicRequest={access["public-request"] && !requesting}
                    canEdit={access.edit} canAdjust={access.adjust}
                    canTransfer={access.transfer} canReport={access.report}
                    onAction={action => { if (selected) openAction(action, selected); }} />
                  {itemViews.map(view => {
                    const enabled = views.includes(view.key);
                    return (
                      <button key={view.key} type="button" aria-pressed={enabled}
                        disabled={view.key==="card" && (!selected||!canViewCard)}
                        className="design-press-key design-press-key-sm"
                        onClick={() => setViews(previous => previous.includes(view.key)
                          ? previous.filter(value => value !== view.key)
                          : [...previous, view.key])}>
                        {view.label}
                      </button>
                    );
                  })}
                </div>
                {!!companyId && itemViews.filter(view => views.includes(view.key) && (view.key!=="card" || (!!selected&&canViewCard))).map(view => (
                  <div className="work-panel-item-report" key={`${companyId}:${selected?.id ?? "none"}:${view.key}`}>
                    {view.key==="card" ? selected && canViewCard && (
                      <WorkPanelCompactCard userId={user.id} companyId={companyId} itemId={selected.id}
                        canEdit={access.edit} online={online} />
                    ) : <ItemMenuHistory userId={user.id} companyId={companyId}
                      itemId={selected?.id ?? null} itemName={selected?.name ?? null} fixedView={view.key}
                      hideHeading={view.key === "movement"} workPanelMovement={view.key === "movement"} />}
                  </div>
                ))}
              </>
            )} />
        </div>
      </section>
      {notice && <Notice tone={notice.tone}>{notice.message} {notice.memoId && companyId &&
        <Link to={`/companies/${companyId}/memos/${notice.memoId}`}>فتح التقرير</Link>}</Notice>}
      {editingComposition!==null&&context&&canEditComposition&&
        <InvoiceItemCompositionEditor context={context} userId={user.id} compositionId={editingComposition}
          onClose={()=>setEditingComposition(null)} />}
      {active && context && <Suspense fallback={<Notice>جارٍ فتح العملية…</Notice>}>
        {active.action === "adjust" && <AdjustItem context={context} itemId={active.id}
          onClose={() => setActive(null)} onSaved={refreshInventory} />}
        {active.action === "transfer" && <TransferItem context={context} itemId={active.id}
          onClose={() => setActive(null)} onPosted={() => refreshInventory(active.id)} />}
        {active.action === "report" && <ReportItem context={context} itemId={active.id} itemName={active.name}
          onClose={() => setActive(null)} onCreated={memoId => {
            setActive(null);
            setNotice({ tone: "success", message: "تم إرسال التقرير المرتبط بالصنف.", memoId });
          }} />}
      </Suspense>}</>}
      {showAccountSearch&&<section className="work-panel-tool-card work-panel-account-container" aria-label="حاوية الحساب">
        <EntityMenuSearch user={user} companyId={companyId} kind="account" floatingResults fieldLabel="بحث عن حساب" dockSelection={dockSelection.account} renderSelection={(selected)=>companyId ?
          <DockAccountTools key={`${user.id}:${companyId}:${selected?.id??0}:${accountAccess.card}:${accountAccess.ledger}`}
            actorId={user.id} companyId={companyId} selected={selected} canCard={accountAccess.card} canLedger={accountAccess.ledger} />
          : null} />
      </section>}
      {user.owner&&<WorkPanelUserSearch user={user} pages={pagesError?undefined:pageEntries} dockSelection={dockSelection.user} />}
      {showPageSearch&&<WorkPanelPageSearch key={currentPageRoute} user={user} companyId={companyId??undefined} pages={pageEntries} loading={pagesLoading} error={pagesError} currentLabel={currentPageLabel} currentRoute={currentPageRoute} context={context} />}
    </div>
  );
}
