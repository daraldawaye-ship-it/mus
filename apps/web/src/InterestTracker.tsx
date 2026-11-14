import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "./api";

type EventKind = "page_view" | "click" | "card_open" | "search";
type EventInput = { action: EventKind; targetType: string; targetId?: number;
  label?: string; text?: string; path?: string };
type QueuedEvent = { id: string; action: EventKind; targetType: string;
  targetId: number; label: string; text: string; path: string };
const OPT_OUT = "alraesy-interest-opt-out";
const VISITOR = "alraesy-interest-visitor";
const queue: QueuedEvent[] = [];
let visitorFallback: string | null = null;
let flushTimer: number | null = null;
let sending = false;

function preference(): boolean {
  try {
    if (window.localStorage.getItem(OPT_OUT) === "1") return false;
  } catch { return false; }
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl !== true && nav.doNotTrack !== "1";
}
function visitorId(): string {
  try {
    const prior=window.localStorage.getItem(VISITOR);
    if (prior && /^[a-f0-9-]{36}$/i.test(prior)) return prior;
    const id=crypto.randomUUID();
    window.localStorage.setItem(VISITOR,id);
    return id;
  } catch { return visitorFallback ?? (visitorFallback=crypto.randomUUID()); }
}
function schedule(ms = 850) {
  if (flushTimer !== null) return;
  flushTimer=window.setTimeout(()=>{flushTimer=null;void flush();},ms);
}
async function flush(): Promise<void> {
  if(sending || !queue.length || !preference()) return;
  sending=true;
  const events=queue.splice(0,24);
  try {
    await api("/interest-events",{method:"POST",body:{visitorId:visitorId(),events}});
  } catch {
    // Keep a bounded best-effort queue; identical UUIDs prevent double-counting.
    queue.unshift(...events);
    if(queue.length>120) queue.splice(0,queue.length-120);
    sending=false;
    schedule(10000);
    return;
  }
  sending=false;
  if(queue.length) schedule(150);
}
export function recordInterest(input: EventInput): void {
  if(!preference())return;
  const path=(input.path ?? window.location.pathname).split(/[?#]/,1)[0].slice(0,220);
  queue.push({id:crypto.randomUUID(),action:input.action,
    targetType:input.targetType.slice(0,48),targetId:input.targetId ?? 0,
    label:(input.label ?? "").slice(0,120),text:(input.text ?? "").slice(0,150),path});
  if(queue.length>120)queue.shift();
  schedule(queue.length>=20?100:850);
}
function searchField(input: HTMLInputElement): boolean {
  if(input.disabled || input.readOnly || ["password","email","tel","hidden"].includes(input.type))return false;
  const label=[input.name,input.id,input.placeholder,input.getAttribute("aria-label")].join(" ");
  return input.type==="search" || /(?:^|\W)(?:search|query|filter|q)(?:$|\W)|بحث|ابحث|ابحث عن/i.test(label);
}

/** Interaction collection is explicitly limited to navigation, actionable clicks,
 * card opens and debounced searches: no password fields, private form bodies,
 * free-form notes, cursor movements or raw keystroke streams. */
export function InterestTracker() {
  const location=useLocation();
  useEffect(()=>{
    const path=location.pathname;
    if(!/^\/(?:login|register|quick-login)(?:\/|$)/.test(path)) {
      recordInterest({action:"page_view",targetType:"page",path});
      const match=/^\/companies\/(\d+)\/(items|accounts|doctors|employees)\/(\d+)\/?$/.exec(path);
      if(match)recordInterest({action:"card_open",targetType:match[2],targetId:Number(match[3]),path});
    }
  },[location.pathname]);
  useEffect(()=>{
    let searchTimer: number | null=null;
    const click=(event: MouseEvent)=>{
      if(!preference() || !(event.target instanceof Element))return;
      const control=event.target.closest("a,button,[role='button'],summary");
      if(!control || control.closest("[data-no-interest]"))return;
      const label=(control.getAttribute("aria-label") || control.getAttribute("title") ||
        control.textContent || "").replace(/\s+/g," ").trim();
      recordInterest({action:"click",targetType:control.tagName.toLowerCase(),
        label:label.slice(0,110),path:window.location.pathname});
    };
    const onInput=(event: Event)=>{
      if(!(event.target instanceof HTMLInputElement) || !searchField(event.target) || !preference())return;
      const input=event.target, path=window.location.pathname;
      if(searchTimer!==null)window.clearTimeout(searchTimer);
      searchTimer=window.setTimeout(()=>{
        const value=input.isConnected ? input.value.trim() : "";
        if(value && !/^(?:\/login|\/register|\/quick-login)/.test(path))
          recordInterest({action:"search",targetType:path.startsWith("/medicine-market") || path==="/"
            ? "market-search":"site-search",text:value,path});
      },700);
    };
    document.addEventListener("click",click,true);
    document.addEventListener("input",onInput,true);
    return ()=>{document.removeEventListener("click",click,true);
      document.removeEventListener("input",onInput,true);
      if(searchTimer!==null)window.clearTimeout(searchTimer);
    };
  },[]);
  return null;
}
export function InterestPrivacyToggle() {
  const [disabled,setDisabled]=useState(()=>{
    try{return window.localStorage.getItem(OPT_OUT)==="1";}catch{return true;}
  });
  function toggle(){
    try {
      if(disabled)window.localStorage.removeItem(OPT_OUT);
      else {window.localStorage.setItem(OPT_OUT,"1");
        window.localStorage.removeItem(VISITOR);queue.length=0;}
      setDisabled(!disabled);
    } catch { /* Storage is disabled: collection is already disabled. */ }
  }
  return <button type="button" data-no-interest="" onClick={toggle}
    title="تسجيل تفاعلات التنقل والبحث والكروت لتحسين الموقع، دون تسجيل كلمات المرور والبيانات المدخلة في النماذج"
    style={{background:"transparent",border:0,padding:0,font:"inherit",cursor:"pointer",textDecoration:"underline",color:"inherit"}}>
    {disabled?"تفعيل إحصاءات الاهتمامات":"إيقاف إحصاءات الاهتمامات"}
  </button>;
}
