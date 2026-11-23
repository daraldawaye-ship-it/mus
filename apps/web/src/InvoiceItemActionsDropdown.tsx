import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Pencil } from "lucide-react";

export type InvoiceItemAction = "public-request" | "edit" | "adjust" | "transfer" | "report";

export const invoiceItemActionLabels: Record<InvoiceItemAction, string> = {
  "public-request": "طلب الجمهور",
  edit: "تعديل كرت الصنف",
  adjust: "تسوية الصنف",
  transfer: "مناقلة صنف",
  report: "إرسال تقرير مرتبط بالصنف",
};

/** Portal-based dropdown escapes the horizontally scrolling invoice matrix. */
export function InvoiceItemActionsDropdown({
  itemName, disabled, canPublicRequest = false, canEdit, canAdjust, canTransfer, canReport, onAction, onOpenChange, onEditComposition, triggerLabel, unavailableCompositionReason,
}: {
  itemName: string;
  disabled: boolean;
  canPublicRequest?: boolean;
  canEdit: boolean;
  canAdjust: boolean;
  canTransfer: boolean;
  canReport: boolean;
  onAction: (action: InvoiceItemAction) => void;
  onOpenChange?: (open:boolean)=>void;
  onEditComposition?: ()=>void;
  unavailableCompositionReason?: string;
  triggerLabel?: string;
}) {
  return <ItemDropdown itemName={itemName} disabled={disabled} triggerLabel={triggerLabel} onOpenChange={onOpenChange} showPencil={!triggerLabel}>
        {close => (["public-request","edit","adjust","transfer","report"] as const).map(action=>
          <Fragment key={action}><button type="button" role="menuitem"
            disabled={action==="public-request"?!canPublicRequest:action==="edit"?!canEdit:action==="adjust"?!canAdjust:action==="transfer"?!canTransfer:!canReport}
            title={action==="public-request"&&!canPublicRequest?"طلب الجمهور غير متاح لهذا المستخدم":
              action==="edit"&&!canEdit?"تعديل الأصناف غير مسموح":
              action==="adjust"&&!canAdjust?"تسوية الصنف تحتاج صلاحيات المخزون والمالية":
              action==="transfer"&&!canTransfer?"مناقلة الصنف تحتاج صلاحية ترحيل المخزون":
              action==="report"&&!canReport?"إرسال تقرير يحتاج صلاحية إنشاء المذكرات":undefined}
            onClick={()=>{close();onAction(action);}}>
            {invoiceItemActionLabels[action]}
          </button>
          {action==="edit"&&(onEditComposition||unavailableCompositionReason)&&<button type="button" role="menuitem"
            disabled={!onEditComposition} title={unavailableCompositionReason}
            onClick={()=>{if(onEditComposition){close();onEditComposition();}}}>
            تعديل كرت التركيب{!onEditComposition&&<small> ({unavailableCompositionReason})</small>}
          </button>}
          </Fragment>
        )}
  </ItemDropdown>;
}

export function WorkPanelItemViewsDropdown({itemName,disabled,views}:{
  itemName:string;disabled:boolean;views:{key:string;label:string;available:boolean;checked:boolean;toggle:()=>void}[];
}) {
  return <ItemDropdown itemName={itemName} disabled={disabled} triggerLabel="إجراءات">
    {() => views.map(view => <button type="button" role="menuitemcheckbox" aria-checked={view.checked}
      key={view.key} className="work-panel-view-menu-entry" disabled={!view.available}
      onClick={view.toggle}>{view.label}{!view.available&&<small> (لا يتوفر إذن العرض)</small>}</button>)}
  </ItemDropdown>;
}

function ItemDropdown({itemName,disabled,triggerLabel,showPencil,onOpenChange,children}:{
  itemName:string;disabled:boolean;triggerLabel?:string;showPencil?:boolean;
  onOpenChange?:(open:boolean)=>void;children:(close:()=>void)=>ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusMenu = useRef(false);
  const [position, setPosition] = useState<{top:number;left:number}|null>(null);
  function close() { setPosition(null); onOpenChange?.(false); }
  function toggle() {
    if(position){close();return;}
    const rect=button.current?.getBoundingClientRect();
    if(!rect)return;
    const viewport=window.visualViewport;
    const menuWidth=Math.min(270,(viewport?.width??window.innerWidth)-16);
    const viewportTop=viewport?.offsetTop??0;
    const viewportLeft=viewport?.offsetLeft??0;
    const viewportBottom=viewportTop+(viewport?.height??window.innerHeight);
    const viewportRight=viewportLeft+(viewport?.width??window.innerWidth);
    focusMenu.current = !!triggerLabel;
    onOpenChange?.(true);
    setPosition({
      top: Math.max(viewportTop+8,Math.min(rect.bottom+4,viewportBottom-160)),
      left: Math.max(viewportLeft+8,Math.min(rect.right-menuWidth,viewportRight-menuWidth-8)),
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
    const scroll=(event:Event)=>{
      // If this menu itself needs to scroll on a short screen, keep it open.
      if(event.target instanceof Node && menu.current?.contains(event.target))return;
      close();
    };
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
      title={disabled?"اختر الصنف أولًا":`${triggerLabel??"خيارات الصنف"}: ${itemName}`}
      aria-label={`${triggerLabel??"خيارات الصنف"} ${itemName||""}`}
      aria-haspopup="menu" aria-expanded={!!position} disabled={disabled} onClick={toggle}
      onKeyDown={event=>{
        if(triggerLabel&&event.key==="ArrowDown"&&!position){event.preventDefault();toggle();}
      }}>
      {showPencil&&<Pencil size={15} aria-hidden="true"/>}{triggerLabel}<ChevronDown size={13} aria-hidden="true"/>
    </button>
    {position && createPortal(
      <div ref={element=>{
        if(element&&focusMenu.current){
          focusMenu.current=false;
          (element.querySelector<HTMLElement>("button:not(:disabled)")??element).focus({preventScroll:true});
        }
        menu.current=element;
      }} role="menu" tabIndex={triggerLabel?-1:undefined} dir={triggerLabel?"rtl":undefined} aria-label={`${triggerLabel??"خيارات الصنف"} ${itemName}`}
        className="invoice-item-actions-dropdown" style={{top:position.top,left:position.left,maxHeight:`calc(100dvh - ${position.top+8}px)`,overflowY:"auto"}}
        onKeyDown={event=>{
          if(!triggerLabel||!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
          const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          if(!buttons.length)return;
          event.preventDefault();
          const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[event.key==="Home"?0:event.key==="End"?buttons.length-1:
            (index+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length]?.focus();
        }}>
        {children(close)}
      </div>,
      document.body,
    )}
  </>;
}
