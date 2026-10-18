import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Pencil } from "lucide-react";

export type InvoiceItemAction = "edit" | "adjust" | "report";

export const invoiceItemActionLabels: Record<InvoiceItemAction, string> = {
  edit: "تعديل كرت الصنف",
  adjust: "تسوية الصنف",
  report: "إرسال تقرير مرتبط بالصنف",
};

/** Portal-based dropdown escapes the horizontally scrolling invoice matrix. */
export function InvoiceItemActionsDropdown({
  itemName, disabled, canEdit, canAdjust, canReport, onAction,
}: {
  itemName: string;
  disabled: boolean;
  canEdit: boolean;
  canAdjust: boolean;
  canReport: boolean;
  onAction: (action: InvoiceItemAction) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{top:number;left:number}|null>(null);
  function close() { setPosition(null); }
  function toggle() {
    if(position){close();return;}
    const rect=button.current?.getBoundingClientRect();
    if(!rect)return;
    const menuWidth=Math.min(270,window.innerWidth-16);
    setPosition({
      top: Math.max(8,Math.min(rect.bottom+4,window.innerHeight-160)),
      left: Math.max(8,Math.min(rect.right-menuWidth,window.innerWidth-menuWidth-8)),
    });
  }
  useEffect(()=>{
    if(!position)return;
    const outside=(event:PointerEvent)=>{
      const target=event.target as Node;
      if(!button.current?.contains(target)&&!menu.current?.contains(target))close();
    };
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){event.preventDefault();close();button.current?.focus();}
    };
    const scroll=()=>close();
    document.addEventListener("pointerdown",outside);
    document.addEventListener("keydown",keydown);
    window.addEventListener("resize",scroll);
    // Capture scrolling of the invoice's inner table, too.
    window.addEventListener("scroll",scroll,true);
    return ()=>{
      document.removeEventListener("pointerdown",outside);
      document.removeEventListener("keydown",keydown);
      window.removeEventListener("resize",scroll);
      window.removeEventListener("scroll",scroll,true);
    };
  },[position]);
  return <>
    <button ref={button} type="button" className="button button-ghost button-compact invoice-item-actions-trigger"
      title={disabled?"اختر الصنف أولًا":`خيارات الصنف: ${itemName}`}
      aria-label={`خيارات الصنف ${itemName||""}`}
      aria-haspopup="menu" aria-expanded={!!position} disabled={disabled} onClick={toggle}>
      <Pencil size={15} aria-hidden="true"/><ChevronDown size={13} aria-hidden="true"/>
    </button>
    {position && createPortal(
      <div ref={menu} role="menu" aria-label={`خيارات الصنف ${itemName}`}
        className="invoice-item-actions-dropdown" style={{top:position.top,left:position.left}}>
        {(["edit","adjust","report"] as const).map(action=>
          <button key={action} type="button" role="menuitem"
            disabled={action==="edit"?!canEdit:action==="adjust"?!canAdjust:!canReport}
            title={action==="edit"&&!canEdit?"تعديل الأصناف غير مسموح":
              action==="adjust"&&!canAdjust?"تسوية الصنف تحتاج صلاحيات المخزون والمالية":
              action==="report"&&!canReport?"إرسال تقرير يحتاج صلاحية إنشاء المذكرات":undefined}
            onClick={()=>{close();onAction(action);}}>
            {invoiceItemActionLabels[action]}
          </button>
        )}
      </div>,
      document.body,
    )}
  </>;
}
