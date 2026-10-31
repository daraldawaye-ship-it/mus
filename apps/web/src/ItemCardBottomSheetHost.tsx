import { lazy, Suspense, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CompanyContext, Item } from "../../../packages/contracts/src/index";
import { Dialog, Notice } from "./ui";
const Editor = lazy(() => import("./pages/ItemsPages").then(m => ({ default: m.InvoiceItemEditor })));
const EVENT_NAME = "alraesy:open-item-card-sheet";

/** Open a company item card without navigating away from the user's work. */
export function openItemCardSheet(companyId: number, itemId: number): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { companyId, itemId } }));
  }
}

export function ItemCardBottomSheetHost({ context }: { context: CompanyContext | undefined }) {
  const [itemId, setItemId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const companyId = context?.company.id;
  useEffect(() => { setItemId(null); setBusy(false); }, [companyId]);
  useEffect(() => {
    if (!companyId) return;
    const onOpen = (event: Event) => {
      const data = (event as CustomEvent<{ companyId: number; itemId: number }>).detail;
      if (data?.companyId !== companyId || !Number.isSafeInteger(data.itemId)
        || data.itemId <= 0) return;
      setItemId(data.itemId);
    };
    const onLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey
        || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)
        || anchor.hasAttribute("download") || anchor.target === "_blank"
        || anchor.hasAttribute("data-open-item-full-page")) return;
      const path = new URL(anchor.href, window.location.href);
      if (path.origin !== window.location.origin) return;
      const match = /^\/companies\/(\d+)\/items\/(\d+)\/?$/.exec(path.pathname);
      if (!match || Number(match[1]) !== companyId) return;
      event.preventDefault();
      event.stopPropagation();
      setItemId(Number(match[2]));
    };
    window.addEventListener(EVENT_NAME, onOpen);
    document.addEventListener("click", onLink, true);
    return () => {
      window.removeEventListener(EVENT_NAME, onOpen);
      document.removeEventListener("click", onLink, true);
    };
  }, [companyId]);
  if (!context) return null;
  const close = () => { if (!busy) setItemId(null); };
  const saved = (_item: Item) => {
    void client.invalidateQueries({ queryKey: ["item-options-list"] });
    void client.invalidateQueries({ queryKey: ["items"] });
    close();
  };
  return <Dialog open={itemId !== null} title="كرت الصنف" className="invoice-item-sheet"
    onClose={close}>
    {itemId !== null && <Suspense fallback={<Notice>جارٍ فتح كرت الصنف…</Notice>}>
      <Editor key={`${context.company.id}:${itemId}`} context={context} itemId={itemId}
        onSavingChange={setBusy} onClose={close} onSaved={saved} />
    </Suspense>}
  </Dialog>;
}
