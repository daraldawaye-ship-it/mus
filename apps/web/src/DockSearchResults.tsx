import {useEffect,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from "react";
import {createPortal} from "react-dom";
import {dockSearchPlacement} from "./dock-search-placement";

const tabbable='a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]';

export function focusFirstDockResult(resultsId:string){
  const results=document.getElementById(resultsId);
  if(!results?.closest("[data-dock-search-layer]:not([hidden])"))return false;
  const control=results.querySelector<HTMLElement>(tabbable);
  if(!control)return false;
  control.focus();
  return true;
}

export function isDockResultFocus(resultsId:string,target:EventTarget|null){
  return target instanceof Node && !!document.getElementById(resultsId)?.contains(target);
}

export function DockSearchResults({anchor,children,onDismiss}:{
  anchor:RefObject<HTMLElement|null>;children:ReactNode;onDismiss:()=>void;
}){
  const layer=useRef<HTMLDivElement>(null);
  const dismiss=useRef(onDismiss);
  dismiss.current=onDismiss;
  const [position,setPosition]=useState<ReturnType<typeof dockSearchPlacement>>(null);
  useLayoutEffect(()=>{
    const field=anchor.current;if(!field)return;
    const viewport=window.visualViewport;
    const scrollArea=field.closest(".resizable-work-panel-content");
    const frame=field.closest(".resizable-work-panel-frame");
    const layout=field.closest(".resizable-work-panel-layout");
    let raf:number|null=null;
    const measure=()=>{
      raf=null;
      const next=dockSearchPlacement(field.getBoundingClientRect(),{
        top:viewport?.offsetTop??0, left:viewport?.offsetLeft??0,
        width:viewport?.width??window.innerWidth,height:viewport?.height??window.innerHeight,
      },scrollArea?.getBoundingClientRect());
      setPosition(previous=>previous&&next&&previous.left===next.left&&previous.top===next.top&&
        previous.maxHeight===next.maxHeight&&previous.width===next.width&&previous.side===next.side ? previous : next);
    };
    const schedule=()=>{if(raf===null)raf=window.requestAnimationFrame(measure);};
    measure();
    const observer=typeof ResizeObserver==="undefined"?null:new ResizeObserver(schedule);
    for(const element of [field,scrollArea,frame,layout])if(element)observer?.observe(element);
    window.addEventListener("resize",schedule);
    window.addEventListener("scroll",schedule,{capture:true,passive:true});
    viewport?.addEventListener("resize",schedule);
    viewport?.addEventListener("scroll",schedule);
    return ()=>{
      if(raf!==null)window.cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize",schedule);
      window.removeEventListener("scroll",schedule,true);
      viewport?.removeEventListener("resize",schedule);
      viewport?.removeEventListener("scroll",schedule);
    };
  },[anchor]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{
      if(event.target instanceof Node && !anchor.current?.contains(event.target) && !layer.current?.contains(event.target))
        dismiss.current();
    };
    document.addEventListener("pointerdown",outside,true);
    return ()=>document.removeEventListener("pointerdown",outside,true);
  },[anchor]);

  return createPortal(<div ref={layer} dir="rtl" data-dock-search-layer=""
    className="dock-search-results-layer" data-side={position?.side}
    style={position?{left:position.left,top:position.top,width:position.width,maxHeight:position.maxHeight}:undefined}
    hidden={!position} onKeyDown={event=>{
      const input=anchor.current?.querySelector<HTMLElement>("input");
      if(event.key==="Escape"){
        event.stopPropagation();event.preventDefault();input?.focus();dismiss.current();
      }
      if(event.key!=="Tab")return;
      const nodes=Array.from(event.currentTarget.querySelectorAll<HTMLElement>(tabbable));
      if(event.shiftKey&&nodes[0]===event.target){
        event.preventDefault();input?.focus();
      }else if(!event.shiftKey&&nodes.at(-1)===event.target&&input){
        const frame=anchor.current?.closest(".resizable-work-panel-frame");
        const controls=Array.from(frame?.querySelectorAll<HTMLElement>(tabbable)??[]);
        const next=controls[controls.indexOf(input)+1];
        if(next&&next!==input){event.preventDefault();next.focus();}
        dismiss.current();
      }
    }}>
    {children}
  </div>,document.body);
}
