import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Item } from "../../../packages/contracts/src/index";
import { api, ApiFailure, sessionRequiresLogin, useScopeGuard } from "./api";
import { isOfflineNow } from "./connection-mode";
import { Notice } from "./ui";
import { ItemOrderStopQuickActions } from "./ItemSpecialOrderQuickActions";
import { errorMessage } from "./phase2";
import { compactItemDraft, compactItemSingleFieldPatch, compactNumericFields, createCompactItemAutosave,
  stepCompactItemValue, type CompactItemDraft, type CompactItemField, type CompactItemValue } from "./work-panel-compact-card";

type Props = { userId:number; companyId:number; itemId:number; canEdit:boolean; canStopOrder:boolean; online:boolean };
export function WorkPanelCompactCard(props:Props) {
  const {userId,companyId,itemId}=props;
  const query=useQuery({
    queryKey:["work-panel-compact-card",userId,companyId,itemId],
    queryFn:({signal})=>api<{item:Item}>(`/companies/${companyId}/items/${itemId}`,{signal}),
    staleTime:0,
  });
  if (query.isPending) return <p className="user-menu-entity-hint">جارٍ تحميل كرت الصنف…</p>;
  const item=query.data?.item;
  if (!item || item.id!==itemId || item.companyId!==companyId)
    return <Notice tone="error">تعذر تحميل كرت هذا الصنف.</Notice>;
  return <CompactItemEditor key={`${userId}:${companyId}:${itemId}`} {...props} initial={item}
    reload={async()=>{
      const refreshed=await query.refetch({throwOnError:true});
      const item=refreshed.data?.item;
      if (!item || item.id!==itemId || item.companyId!==companyId) throw new Error("تعذر إعادة تحميل الصنف.");
      return item;
    }}/>;
}

function CompactItemEditor({userId,companyId,itemId,canEdit,canStopOrder,online,initial,reload}:
    Props & {initial:Item;reload:()=>Promise<Item>}) {
  const baseline=useRef(initial);
  const current=useRef(compactItemDraft(initial));
  const revisions=useRef<Partial<Record<CompactItemField,number>>>({});
  const openingRevision=useRef(initial.revision);
  const [draft,setDraft] = useState(current.current);
  const [pending,setPending] = useState<Partial<Record<CompactItemField,boolean>>>({});
  const [errors,setErrors] = useState<Partial<Record<CompactItemField,{message:string;conflict?:boolean}>>>({});
  const blocked=useRef(new Set<CompactItemField>());
  const [reloadField,setReloadField]=useState<CompactItemField|null>(null);
  const client=useQueryClient();
  const guard=useScopeGuard(`work-panel-compact-card:${userId}:${companyId}:${itemId}`);
  const id=useId();
  const access=useRef(canEdit);
  access.current=canEdit;
  // The queue captures this item's scope once, while its delegate reads
  // the latest authorized state. Unmount never redirects a pending write.
  const saveField=useRef<(key:CompactItemField,value:CompactItemValue)=>Promise<void>>(async()=>{});
  const [queue]=useState(()=>createCompactItemAutosave(
    ()=>guard.isCurrent(),(key,value)=>saveField.current(key,value),
    (key,value)=>setPending(old=>({...old,[key]:value})),
  ));

  function setValue<K extends CompactItemField>(key:K,value:CompactItemDraft[K]) {
    current.current={...current.current,[key]:value};
    setDraft(current.current);
  }

  useEffect(()=>{
    // Merge network refetch only into clean fields, without rebasing a
    // typed or pending edit against a different actor's changes.
    const old=compactItemDraft(baseline.current);
    const fresh=compactItemDraft(initial);
    for (const key of [...compactNumericFields.map(field=>field.key),"reviewed"] as const) {
      if (initial.revision<=(revisions.current[key]??openingRevision.current) || current.current[key]!==old[key] ||
          blocked.current.has(key) || queue.isPending(key)) continue;
      baseline.current={...baseline.current,[key]:initial[key]};
      revisions.current[key]=initial.revision;
      current.current={...current.current,[key]:fresh[key]};
    }
    setDraft(current.current);
  },[initial,queue,pending]);

  function fieldError(key:CompactItemField,message:string,conflict=false) {
    setErrors(old=>({...old,[key]:{message,conflict}}));
  }
  function clearError(key:CompactItemField) {
    setErrors(old=>({...old,[key]:undefined}));
  }
  function mergeSavedField(key:CompactItemField,item:Item) {
    baseline.current={...baseline.current,[key]:item[key]};
    revisions.current[key]=item.revision;
  }
  saveField.current=async(key,value)=>{
    if (blocked.current.has(key) || !guard.isCurrent()) return;
    if (!access.current || isOfflineNow() || sessionRequiresLogin()) {
      fieldError(key,"لا يمكن الحفظ دون اتصال وجلسة صالحة.");
      return;
    }
    const result=compactItemSingleFieldPatch(baseline.current,key,value);
    if (result.error!==undefined) {fieldError(key,result.error);return;}
    clearError(key);
    if (!result.payload) return;
    try {
      const response=await api<{item:Item}>(`/companies/${companyId}/items/${itemId}`,{
        method:"PATCH",body:result.payload,signal:guard.signal,
      });
      if (!guard.isCurrent()) return;
      const item=response.item;
      if(item.id!==itemId||item.companyId!==companyId) throw new Error("تعذر تأكيد الصنف المحفوظ.");
      mergeSavedField(key,item);
      // Do not replace the whole cached response from parallel field saves.
      if (current.current[key]===value) setValue(key,compactItemDraft(item)[key]);
      for (const queryKey of [
        ["work-panel-compact-card",userId,companyId,itemId],
        ["items",userId,companyId],["item-options-list",userId,companyId],
        ["avatar-item-alternatives",userId,companyId,itemId],
      ]) void client.invalidateQueries({queryKey});
    } catch(reason) {
      if (!guard.isCurrent()) return;
      if(reason instanceof ApiFailure&&reason.status===409) {
        blocked.current.add(key);
        fieldError(key,"تغيّرت القيمة المحفوظة؛ حمّلها قبل تعديل هذا الحقل مجددًا.",true);
      } else fieldError(key,errorMessage(reason));
      // A failed write cannot provide the next expected value.
      throw reason;
    }
  };
  function commit(key:CompactItemField,value:CompactItemValue=current.current[key]) {
    if(canEdit&&online&&!blocked.current.has(key))
      void queue.enqueue(key,value).catch(()=>{ /* The field displays the error. */ });
  }
  async function reloadSaved(key:CompactItemField) {
    if(reloadField||!canEdit||!online||!guard.isCurrent()||queue.isPending(key)) return;
    setReloadField(key);
    try {
      const item=await reload();
      if(!guard.isCurrent())return;
      mergeSavedField(key,item);
      setValue(key,compactItemDraft(item)[key]);
      blocked.current.delete(key);
      clearError(key);
    } catch(reason) {
      if(guard.isCurrent())fieldError(key,errorMessage(reason),blocked.current.has(key));
    } finally {
      if(guard.isCurrent())setReloadField(null);
    }
  }
  const disabled=!canEdit||!online;
  const status=(key:CompactItemField,label:string)=>{
    const issue=errors[key];
    if(pending[key])return <small role="status">جارٍ حفظ {label}…</small>;
    if(!issue)return null;
    return <div>
      <small role="alert">{issue.message}</small>
      {issue.conflict&&<button type="button" className="button button-secondary button-compact"
        disabled={disabled||reloadField!==null} onClick={()=>void reloadSaved(key)}>تحميل القيمة المحفوظة</button>}
    </div>;
  };
  const onEnter=(event:KeyboardEvent<HTMLInputElement>,key:CompactItemField)=>{
    if(event.key==="Enter"&&!event.nativeEvent.isComposing){
      event.preventDefault();
      event.stopPropagation();
      commit(key);
    }
  };
  return <section className="work-panel-compact-card" aria-label="كرت الصنف المختصر">
    <div className="work-panel-compact-fields">
      {compactNumericFields.map(({key,label,hint})=>{
        const fieldId=id+"-"+key;
        const unavailable=disabled||!!errors[key]?.conflict||reloadField===key;
        const step=(direction:-1|1)=>stepCompactItemValue(key,draft[key],direction);
        const apply=(direction:-1|1)=>{
          const value=stepCompactItemValue(key,current.current[key],direction);
          setValue(key,value);
          commit(key,value);
        };
        return <div className="work-panel-compact-field" key={key}>
          <div className="work-panel-compact-stepper" dir="ltr" onBlur={event=>{
            // Moving focus to this same field's step buttons is not an edit
            // commit; the button will send its final value directly.
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) commit(key);
          }}>
            <label className="work-panel-compact-label" dir="rtl" htmlFor={fieldId} title={hint}>{label}</label>
            <button type="button" disabled={unavailable||step(-1)===draft[key]}
              aria-label={`نقص ${label}`} onClick={()=>apply(-1)}>−</button>
            <input id={fieldId} inputMode="numeric" maxLength={22} value={draft[key]} disabled={unavailable}
              autoComplete="off" title={hint} onChange={event=>setValue(key,event.target.value)}
              onKeyDown={event=>onEnter(event,key)}/>
            <button type="button" disabled={unavailable||step(1)===draft[key]}
              aria-label={`زيادة ${label}`} onClick={()=>apply(1)}>+</button>
          </div>
          {status(key,label)}
        </div>;
      })}
      <div className="work-panel-compact-field work-panel-compact-actions">
        <label className="check-label"><input type="checkbox" checked={draft.reviewed}
          disabled={disabled||!!errors.reviewed?.conflict||reloadField==="reviewed"}
          onChange={event=>{setValue("reviewed",event.target.checked);commit("reviewed",event.target.checked);}}/>مراجع</label>
        {status("reviewed","مراجع")}
      </div>
      <div className="work-panel-compact-field work-panel-compact-actions">
        <ItemOrderStopQuickActions compact companyId={companyId} itemId={itemId} itemName={initial.name}
          revision={Math.max(initial.revision, ...Object.values(revisions.current).map(value => value ?? 0))}
          orderStoppedUntil={initial.orderStoppedUntil}
          canEdit={canStopOrder&&online&&!Object.values(pending).some(Boolean)} />
      </div>
    </div>
    {Object.values(pending).some(Boolean)&&<small>انتظر اكتمال الحفظ قبل الانتقال إلى صنف آخر.</small>}
  </section>;
}
