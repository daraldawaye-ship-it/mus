import {dockInteractiveSelector} from "./dock-table-references";

type RowClick = Pick<MouseEvent,"detail"|"defaultPrevented"|"altKey"|"ctrlKey"|"shiftKey"|"metaKey"> & {
  target:EventTarget|null;
  currentTarget:HTMLElement;
  nativeEvent:MouseEvent;
};

/** A genuine tap/click on an ordinary row cell, not a nested control or selection gesture. */
export function isDockRowClick(event:RowClick,rowSelector:string):boolean {
  const native=event.nativeEvent as MouseEvent & {
    pointerType?:string;sourceCapabilities?:{firesTouchEvents:boolean}|null;
  };
  const singleTap=event.detail===1 || (event.detail===0 && native.isTrusted &&
    (native.pointerType==="touch" || native.pointerType==="pen" || native.sourceCapabilities?.firesTouchEvents===true));
  if(!singleTap||event.defaultPrevented||event.altKey||event.ctrlKey||event.shiftKey||event.metaKey)return false;
  const source=event.target as (Node & Partial<Element>)|null;
  const target=typeof source?.closest==="function" ? source as Element : source?.parentElement;
  if(!target || target.closest(rowSelector)!==event.currentTarget || target.closest(dockInteractiveSelector))return false;
  const selection=target.ownerDocument.getSelection();
  return !selection || selection.isCollapsed || !selection.containsNode(event.currentTarget,true);
}
