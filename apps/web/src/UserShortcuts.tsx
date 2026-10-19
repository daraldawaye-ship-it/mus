import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { ChevronDown, ChevronLeft, ChevronRight, ListTree, Settings2, TableProperties } from "lucide-react";
import type { PageEntry, User, GeneralTableInput } from "../../../packages/contracts/src/index";
import { generalTableSchema } from "../../../packages/contracts/src/index";
import { api } from "./api";
import { usePageDirectory } from "./page-directory";
import { useControls } from "./control";
import { errorMessage } from "./phase2";
import { Button, Dialog, Field, Notice } from "./ui";
import { positionShortcutFlyout, shortcutUsesHover, type ShortcutPlacement } from "./shortcut-position";

type Shortcuts = {pageKeys:string[]};
type ShortcutsProps = {
  user:User;
  companyId:number|null;
  employeeId:number|null;
  onNavigate:()=>void;
  onManage:()=>void;
  onQuickAdd:()=>void;
};
const url=(companyId:number|null)=>"/my-shortcuts"+(companyId?"?companyId="+companyId:"");
const canShortcut=(entry:PageEntry,companyId:number|null):boolean=>
  entry.enabled && entry.actionAccess.view && !!entry.href &&
  !entry.record && (entry.scope==="public" || companyId!==null);

export function UserShortcutFlyout({
  user,companyId,employeeId,onNavigate,onManage,onQuickAdd,
}:ShortcutsProps) {
  const [open,setOpen]=useState(false);
  const [placement,setPlacement]=useState<ShortcutPlacement>({mode:"inline"});
  const root=useRef<HTMLDivElement>(null);
  const flyout=useRef<HTMLDivElement>(null);
  const flyoutId=useId();
  const catalog=usePageDirectory(companyId??undefined);
  const settings=useControls(companyId??0,employeeId);
  const shortcutQuery=useQuery({
    queryKey:["my-shortcuts",user.id,companyId],
    queryFn:({signal})=>api<Shortcuts>(url(companyId),{signal}),
  });
  const lookup=new Map((catalog.data??[])
    .filter(entry=>canShortcut(entry,companyId))
    .map(entry=>[entry.key,entry]));
  const defaultPage=lookup.get(companyId?"company.pages":"public.pages")
    ??lookup.get("public.pages");
  // Keep the default entry visible while the persisted-company catalog loads.
  // Authorization remains checked by the page route itself; when the catalog
  // resolves, only enabled and currently viewable links are retained.
  const loadingDefaultHref = !catalog.data && catalog.isLoading
    ? (companyId ? `/companies/${companyId}/pages` : "/pages") : null;
  const defaultHref = defaultPage?.href ?? loadingDefaultHref;
  const shortcuts=(shortcutQuery.data?.pageKeys??[])
    .map(key=>lookup.get(key)).filter((entry):entry is PageEntry=>
      !!entry && entry.key!==defaultPage?.key);
  const quickAllowed=(user.owner||user.kind==="admin") &&
    !!lookup.get("public.general-table")?.actionAccess.create;
  useLayoutEffect(()=>{
    if(!open)return;
    const position=()=>{
      const anchor=root.current?.getBoundingClientRect();
      if(!anchor)return;
      // scrollHeight measures all links, even if the inline preview is
      // currently scroll-clipped. It changes when shortcuts load.
      const measuredHeight=Math.ceil(flyout.current?.scrollHeight??0)+2;
      const next=positionShortcutFlyout(anchor,{
        width:window.innerWidth,height:window.innerHeight,
      },measuredHeight);
      setPlacement(previous=>{
        if(previous.mode!==next.mode)return next;
        if(previous.mode==="inline")return previous;
        if(next.mode==="side" && previous.side===next.side &&
          previous.left===next.left && previous.top===next.top &&
          previous.width===next.width &&
          previous.maxHeight===next.maxHeight)return previous;
        return next;
      });
    };
    position();
    window.addEventListener("resize",position);
    window.addEventListener("scroll",position,true);
    const observer=typeof ResizeObserver!=="undefined"
      ? new ResizeObserver(position):null;
    if(flyout.current)observer?.observe(flyout.current);
    return ()=>{
      window.removeEventListener("resize",position);
      window.removeEventListener("scroll",position,true);
      observer?.disconnect();
    };
  },[open,shortcuts.length,!!defaultHref,quickAllowed,
     catalog.isLoading,shortcutQuery.isError]);
  if(settings.value("show_shortcuts_menu")===false)return null;
  return <div className="user-shortcut-root" ref={root}
    // Touch devices synthesize mouseenter before click. The old mouseenter
    // opened the flyout, then the same tap's click toggled it closed.
    // Only real mouse pointer movement triggers hover; touch uses click once.
    onPointerEnter={event=>{
      if(event.pointerType==="mouse")setOpen(true);
    }}
    onPointerLeave={event=>{
      if(event.pointerType==="mouse")setOpen(false);
    }}
    onKeyDown={event=>{
      if(event.key==="Escape" && open){
        event.stopPropagation();
        setOpen(false);
      }
    }}>
    <button className="user-menu-item" role="menuitem" type="button"
      aria-haspopup="true" aria-expanded={open}
      aria-controls={open?flyoutId:undefined}
      onClick={()=>setOpen(v=>!v)}
      onKeyDown={event=>{
        if(event.key==="ArrowLeft" || event.key==="ArrowRight"){
          event.preventDefault();setOpen(true);
        }
      }}>
      <ListTree size={17} aria-hidden="true"/>
      <span>اختصار إلى</span>
      {placement.mode==="inline"
        ? <ChevronDown size={14} aria-hidden="true" className="user-shortcut-arrow"/>
        : placement.side==="left"
          ? <ChevronLeft size={14} aria-hidden="true" className="user-shortcut-arrow"/>
          : <ChevronRight size={14} aria-hidden="true" className="user-shortcut-arrow"/>}
    </button>
    {open&&<div id={flyoutId} ref={flyout}
      className={`user-shortcut-flyout user-shortcut-flyout--${placement.mode}`}
      style={placement.mode==="side"?{
        left:placement.left,top:placement.top,
        width:placement.width,maxHeight:placement.maxHeight,
      }:undefined}
      aria-label="اختصاراتي">
      {defaultHref&&<NavLink to={defaultHref} onClick={onNavigate}
        className="user-menu-item"><ListTree size={15}/>قائمة الصفحات</NavLink>}
      {shortcuts.map(entry=><NavLink key={entry.key} to={entry.href!}
        title={entry.name} onClick={onNavigate} className="user-menu-item">
        <span className="user-shortcut-label">{entry.name}</span>
      </NavLink>)}
      {catalog.isLoading&&<small className="user-shortcut-hint">جارٍ تحميل الصفحات…</small>}
      {shortcutQuery.isError&&<small className="user-shortcut-hint">تعذر تحميل الاختصارات</small>}
      {quickAllowed&&<button type="button" className="user-menu-item" onClick={onQuickAdd}>
        <TableProperties size={15}/>إضافة سريعة إلى الجدول العام
      </button>}
      <button type="button" className="user-menu-item" onClick={onManage}>
        <Settings2 size={15}/>تحديد اختصاراتي
      </button>
    </div>}
  </div>;
}

export function ShortcutEditor({user,companyId,open,onClose}:{
  user:User;companyId:number|null;open:boolean;onClose:()=>void;
}) {
  const client=useQueryClient();
  const directory=usePageDirectory(companyId??undefined);
  const queryKey=["my-shortcuts",user.id,companyId];
  const current=useQuery({
    queryKey,
    queryFn:({signal})=>api<Shortcuts>(url(companyId),{signal}),
    enabled:open,
  });
  const [chosen,setChosen]=useState<string[]>([]);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{if(open && current.data)setChosen(current.data.pageKeys);},
    [open,current.data]);
  const available=useMemo(()=>(directory.data??[])
    .filter(entry=>canShortcut(entry,companyId))
    .sort((a,b)=>a.order-b.order),[directory.data,companyId]);
  async function save() {
    if(saving)return;
    setSaving(true);setError("");
    try {
      const permitted=new Set(available.map(entry=>entry.key));
      const pageKeys=chosen.filter(key=>permitted.has(key));
      const updated=await api<Shortcuts>(url(companyId),{method:"PUT",body:{pageKeys}});
      client.setQueryData(queryKey,updated);
      await client.invalidateQueries({queryKey});
      onClose();
    }catch(err){setError(errorMessage(err));}
    finally{setSaving(false);}
  }
  return <Dialog open={open} onClose={()=>{if(!saving)onClose();}}
    title="تحديد اختصاراتي">
    <div className="form-stack">
      <p className="muted">تُحفظ اختصاراتك لحسابك {companyId?"في هذه الشركة":"في الموقع العام"}.
        تعرض القائمة الصفحات المتاحة لك فقط، وتبقى «قائمة الصفحات» متاحة افتراضيًا.
        التحديد لا يمنح أي صلاحية جديدة.</p>
      {error&&<Notice tone="error">{error}</Notice>}
      {current.isError&&<Notice tone="error">{errorMessage(current.error)}</Notice>}
      <div className="user-shortcut-options">
        {available.map(entry=><label key={entry.key} className="user-shortcut-option">
          <input type="checkbox" checked={chosen.includes(entry.key)}
            disabled={saving}
            onChange={event=>setChosen(old=>event.target.checked
              ? [...old.filter(k=>k!==entry.key),entry.key]
              : old.filter(k=>k!==entry.key))}/>
          <span>{entry.name}</span><small>{entry.section}</small>
        </label>)}
        {directory.isLoading&&<small>جارٍ تحميل قائمة الصفحات…</small>}
      </div>
      <div className="form-actions">
        <Button disabled={saving||directory.isLoading||current.isLoading||!directory.data}
          onClick={()=>void save()}>{saving?"جارٍ الحفظ…":"حفظ الاختصارات"}</Button>
        <Button variant="secondary" onClick={onClose} disabled={saving}>العودة</Button>
      </div>
    </div>
  </Dialog>;
}

const emptyRecord=():GeneralTableInput=>({
  tableName:"",category:"",title:"",description:"",number1:null,number2:null,
  date1:null,date2:null,text1:"",text2:"",text3:"",text4:"",text5:"",
  text6:"",text7:"",text8:"",text9:"",
});
export function GeneralTableQuickAdd({open,onClose}:{
  open:boolean;onClose:()=>void;
}) {
  const suggestId=useId();
  const [draft,setDraft]=useState<GeneralTableInput>(emptyRecord);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const input=useRef<HTMLInputElement>(null);
  const names=useQuery({
    queryKey:["general-table-names",draft.tableName],
    queryFn:({signal})=>api<{items:string[]}>(
      "/general-table/table-names?q="+encodeURIComponent(draft.tableName),{signal}),
    enabled:open,
    staleTime:15000,
  });
  useEffect(()=>{if(open)input.current?.focus();},[open]);
  async function submit(event:FormEvent) {
    event.preventDefault();if(saving)return;
    const parsed=generalTableSchema.safeParse(draft);
    if(!parsed.success){setError(parsed.error.issues[0]?.message??"تحقق من البيانات");return;}
    setError("");setSaving(true);
    try{
      const response=await api<{record:{id:number}}>(
        "/general-table",{method:"POST",body:parsed.data});
      setNotice("تمت الإضافة إلى الجدول العام برقم "+response.record.id);
      setDraft(old=>({...emptyRecord(),tableName:old.tableName}));
    }catch(err){setError(errorMessage(err));}
    finally{setSaving(false);input.current?.focus();}
  }
  return <Dialog open={open} title="إضافة سريعة إلى الجدول العام"
    onClose={()=>{if(!saving)onClose();}}>
    <form className="form-stack" onSubmit={event=>void submit(event)}>
      {error&&<Notice tone="error">{error}</Notice>}
      {notice&&<Notice tone="success">{notice}</Notice>}
      <div className="field floating-ready" data-label-raised="true">
        <label htmlFor={suggestId}>اسم الجدول</label>
        <input id={suggestId} ref={input} list={suggestId+"-names"}
          value={draft.tableName} maxLength={120} required disabled={saving}
          placeholder="اختر اسمًا سابقًا أو اكتب اسمًا جديدًا"
          onChange={event=>setDraft(old=>({...old,tableName:event.target.value}))}/>
        <datalist id={suggestId+"-names"}>
          {names.data?.items.map(name=><option key={name} value={name}/>)}
        </datalist>
      </div>
      <Field label="العنوان" required maxLength={200} value={draft.title}
        onChange={event=>setDraft(old=>({...old,title:event.target.value}))}
        disabled={saving}/>
      <Field label="التصنيف (اختياري)" maxLength={120} value={draft.category}
        onChange={event=>setDraft(old=>({...old,category:event.target.value}))}
        disabled={saving}/>
      <div className="field">
        <label htmlFor={suggestId+"-description"}>ملاحظات (اختياري)</label>
        <textarea id={suggestId+"-description"} rows={3} maxLength={12000}
          disabled={saving} value={draft.description}
          onChange={event=>setDraft(old=>({...old,description:event.target.value}))}/>
      </div>
      <small>يمكن استخدام اسم جدول جديد غير موجود في الاقتراحات.
        الإدخال ينشئ سجلًا جديدًا ولا يغيّر أي سجل سابق.</small>
      <div className="form-actions">
        <Button type="submit" disabled={saving}>{saving?"جارٍ الحفظ…":"إضافة"}</Button>
        <Button type="button" variant="secondary" disabled={saving}
          onClick={onClose}>العودة</Button>
      </div>
    </form>
  </Dialog>;
}
