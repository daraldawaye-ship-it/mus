import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext, Item } from "../../../packages/contracts/src/index.ts";
import { api } from "./api";
import { Notice } from "./ui";

export type ItemQuickInventoryKind = "adjustment" | "transfer";
const EVENT = "alraesy:open-item-inventory-sheet";

const Adjustment = lazy(() => import("./pages/InventoryPages").then(module =>
  ({default:module.InventoryAdjustmentSheet})));
const Transfer = lazy(() => import("./pages/InventoryPages").then(module =>
  ({default:module.InventoryTransferSheet})));

/** No stock write happens on opening; the existing sheets retain their
 * inventory/finance posting permission checks and require explicit submission. */
export function openItemInventorySheet(
  companyId: number, itemId: number, kind: ItemQuickInventoryKind,
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, {
    detail: { companyId, itemId, kind },
  }));
}

export function ItemQuickInventorySheetHost({context}: {
  context: CompanyContext | undefined;
}) {
  const [selected,setSelected] = useState<{companyId:number;itemId:number;kind:ItemQuickInventoryKind}|null>(null);
  const companyId = context?.company.id;
  useEffect(() => {setSelected(null);},[companyId]);
  useEffect(() => {
    if (!companyId) return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{
        companyId:number;itemId:number;kind:ItemQuickInventoryKind;
      }>).detail;
      if (detail?.companyId !== companyId ||
          !Number.isSafeInteger(detail.itemId) || detail.itemId <= 0 ||
          (detail.kind !== "adjustment" && detail.kind !== "transfer")) return;
      setSelected(detail);
    };
    window.addEventListener(EVENT,onOpen);
    return () => window.removeEventListener(EVENT,onOpen);
  },[companyId]);

  const item = useQuery<{item:Item}>({
    queryKey:["quick-item-inventory",companyId,selected?.itemId],
    queryFn:({signal}) => api<{item:Item}>(`/companies/${companyId}/items/${selected!.itemId}`,{signal}),
    enabled:!!context && !!selected && selected.companyId === companyId,
    staleTime:0,
  });
  if (!context || !selected || selected.companyId !== companyId) return null;
  const close=()=>setSelected(null);
  // The dedicated stock sheets create their own full-height bottom panel,
  // backdrop, and close controls; do not nest inside a second dialog.
  if (item.isPending || item.isError || !item.data) return (
    <>
      <div className="inventory-sheet-backdrop" onClick={close} aria-hidden="true"/>
      <section className="inventory-sheet-panel" role="dialog" aria-modal="true"
        aria-label={selected.kind==="adjustment"?"تسوية الصنف":"مناقلة الصنف"}>
        <button type="button" className="button button-secondary" onClick={close}>إغلاق</button>
        {item.isError
          ? <Notice tone="error">تعذر قراءة الصنف؛ تأكد من صلاحياتك ثم حاول مجددًا.</Notice>
          : <Notice>جارٍ تحميل الصنف…</Notice>}
      </section>
    </>
  );
  return <Suspense fallback={<Notice>جارٍ فتح العملية…</Notice>}>
    {selected.kind==="adjustment"
      ? <Adjustment key={`adjustment:${companyId}:${selected.itemId}`}
          context={context} item={item.data.item} onClose={close}/>
      : <Transfer key={`transfer:${companyId}:${selected.itemId}`}
          context={context} item={item.data.item} onClose={close}/>}
  </Suspense>;
}
