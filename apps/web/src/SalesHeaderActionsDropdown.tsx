import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ChevronDown, ListFilter } from "lucide-react";

type Action = "pouch" | "electronic" | "close" | "addPledge" | "listPledges" | "original";

export function SalesHeaderActionsDropdown({
  listUrl, canTransfer, canManagePledges, canEdit, originalVisible, onAction,
}: {
  listUrl: string;
  canTransfer: boolean;
  canManagePledges: boolean;
  canEdit: boolean;
  originalVisible: boolean;
  onAction: (action: Action) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{top:number;left:number;maxHeight:number}|null>(null);
  const width=260;
  const close=()=>setCoords(null);
  const toggle=()=>{
    if (coords) { close(); return; }
    const rect=trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const viewWidth=window.innerWidth;
    const w=Math.min(width,viewWidth-16);
    const below=window.innerHeight-rect.bottom-8;
    const above=below<245 && rect.top>below;
    const maxHeight=Math.max(110,Math.min(340,above?rect.top-12:below));
    setCoords({top:above?Math.max(8,rect.top-maxHeight-4):rect.bottom+4,
      left:Math.max(8,Math.min(rect.right-w,viewWidth-w-8)), maxHeight});
  };
  useEffect(()=>{
    if(!coords)return;
    const onPointer=(event:PointerEvent)=>{
      const target=event.target as Node;
      if(!trigger.current?.contains(target)&&!menu.current?.contains(target))close();
    };
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape"){close();trigger.current?.focus();}};
    const onScroll=()=>close();
    document.addEventListener("pointerdown",onPointer);
    document.addEventListener("keydown",onKey);
    window.addEventListener("scroll",onScroll,true);
    window.addEventListener("resize",onScroll);
    return ()=>{
      document.removeEventListener("pointerdown",onPointer);
      document.removeEventListener("keydown",onKey);
      window.removeEventListener("scroll",onScroll,true);
      window.removeEventListener("resize",onScroll);
    };
  },[coords]);
  const options:{action:Action;label:string;disabled:boolean}[]=[
    {action:"pouch",label:"ترحيل إلى الحافظة",disabled:!canTransfer},
    {action:"electronic",label:"ترحيل إلى المحفظة الإلكترونية",disabled:!canTransfer},
    {action:"close",label:"إغلاق الصندوق",disabled:!canTransfer},
    {action:"addPledge",label:"إضافة رهن",disabled:!canManagePledges},
    {action:"listPledges",label:"عرض الرهونات",disabled:!canManagePledges},
    {action:"original",label:originalVisible?"إخفاء ربط مردود بأصل":"ربط مردود بأصل",disabled:!canEdit},
  ];
  return <>
    <button ref={trigger} type="button" className="button button-secondary button-compact sales-header-actions-trigger"
      aria-haspopup="menu" aria-expanded={!!coords} onClick={toggle}>
      <ListFilter size={15} aria-hidden="true" /> الإجراءات <ChevronDown size={14} aria-hidden="true" />
    </button>
    {coords && createPortal(
      <div ref={menu} className="sales-header-actions-dropdown" role="menu"
        aria-label="إجراءات فاتورة المبيعات"
        style={{position:"fixed",zIndex:10030,top:coords.top,left:coords.left,
          width:Math.min(width,window.innerWidth-16),maxHeight:coords.maxHeight}}>
        <Link role="menuitem" to={listUrl} onClick={close}>قائمة الفواتير</Link>
        {options.map(item=><button type="button" role="menuitem" key={item.action}
          disabled={item.disabled} onClick={()=>{close();onAction(item.action);}}>
          {item.label}
        </button>)}
      </div>, document.body)}
  </>;
}
