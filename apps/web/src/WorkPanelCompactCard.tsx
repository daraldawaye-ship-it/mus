import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Item } from "../../../packages/contracts/src/index";
import { api, ApiFailure, sessionRequiresLogin, useScopeGuard } from "./api";
import { isOfflineNow } from "./connection-mode";
import { Notice } from "./ui";
import { errorMessage } from "./phase2";
import { compactItemDraft, compactItemFieldPatch, compactNumericFields, stepCompactItemValue } from "./work-panel-compact-card";

type Props = { userId:number; companyId:number; itemId:number; canEdit:boolean; online:boolean };
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

function CompactItemEditor({userId,companyId,itemId,canEdit,online,initial,reload}:
    Props & {initial:Item;reload:()=>Promise<Item>}) {
  const [baseline,setBaseline] = useState(initial);
  const [draft,setDraft] = useState(()=>compactItemDraft(initial));
  const [busy,setBusy] = useState(false);
  const [conflict,setConflict] = useState(false);
  const [error,setError] = useState("");
  const [saved,setSaved] = useState(false);
  const flight=useRef(false);
  const client=useQueryClient();
  const guard=useScopeGuard(`work-panel-compact-card:${userId}:${companyId}:${itemId}`);
  const id=useId();
  const previous=compactItemDraft(baseline);
  const dirty=compactNumericFields.some(({key})=>draft[key]!==previous[key]) || draft.reviewed!==previous.reviewed;
  const disabled=!canEdit || !online || busy;
  useEffect(()=>{
    // Let a fresh refetch replace a cached baseline only while the editor is
    // untouched. A local draft keeps its own expected values for server OCC.
    if (!dirty && !busy && initial.revision > baseline.revision) {
      setBaseline(initial);
      setDraft(compactItemDraft(initial));
    }
  },[initial,baseline.revision,dirty,busy]);
  function edit(patch:Partial<typeof draft>) {
    setSaved(false);
    setDraft(old=>({...old,...patch}));
  }
  function reset(item:Item) {
    setBaseline(item);
    setDraft(compactItemDraft(item));
    setConflict(false);
    setError("");
  }
  const available=()=>canEdit && !isOfflineNow() && !sessionRequiresLogin() && guard.isCurrent() && !flight.current;
  async function save(event:FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!available() || conflict) return;
    const result=compactItemFieldPatch(baseline,draft);
    if (result.error!==undefined) {setError(result.error);return;}
    if (!result.payload) {reset(baseline);return;}
    flight.current=true;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const response=await api<{item:Item}>(`/companies/${companyId}/items/${itemId}`,{
        method:"PATCH",body:result.payload,signal:guard.signal,
      });
      if (!guard.isCurrent()) return;
      if (response.item.id!==itemId || response.item.companyId!==companyId) throw new Error("تعذر تأكيد الصنف المحفوظ.");
      reset(response.item);
      setSaved(true);
      client.setQueryData(["work-panel-compact-card",userId,companyId,itemId],response);
      for (const queryKey of [
        ["items",userId,companyId],
        ["item-options-list",userId,companyId],
        ["avatar-item-alternatives",userId,companyId,itemId],
      ]) void client.invalidateQueries({queryKey});
    } catch (reason) {
      if (!guard.isCurrent()) return;
      if (reason instanceof ApiFailure && reason.status===409) {
        setConflict(true);
        setError("تغيّرت قيمة محفوظة. حمّل القيم الحديثة قبل إعادة التعديل.");
      } else setError(errorMessage(reason));
    } finally {
      flight.current=false;
      if (guard.isCurrent()) setBusy(false);
    }
  }
  async function reloadSaved() {
    if(!available()) return;
    flight.current=true;
    setBusy(true);
    try {
      const item=await reload();
      if (guard.isCurrent()) { reset(item);setSaved(false); }
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      flight.current=false;
      if (guard.isCurrent()) setBusy(false);
    }
  }
  return <form className="work-panel-compact-card" aria-label="كرت الصنف المختصر" onSubmit={save}>
    <div className="work-panel-compact-fields">
      {compactNumericFields.map(({key,label,hint})=>{
        const fieldId=id+"-"+key;
        const step=(direction:-1|1)=>stepCompactItemValue(key,draft[key],direction);
        return <div className="work-panel-compact-field" key={key}>
          <label htmlFor={fieldId} title={hint}>{label}</label>
          <div className="work-panel-compact-stepper" dir="ltr">
            <button type="button" disabled={disabled || step(-1)===draft[key]}
              aria-label={`نقص ${label}`} onClick={()=>edit({[key]:step(-1)})}>−</button>
            <input id={fieldId} inputMode="numeric" maxLength={22} value={draft[key]} disabled={disabled}
              autoComplete="off" title={hint} onChange={event=>edit({[key]:event.target.value})}/>
            <button type="button" disabled={disabled || step(1)===draft[key]}
              aria-label={`زيادة ${label}`} onClick={()=>edit({[key]:step(1)})}>+</button>
          </div>
        </div>;
      })}
    </div>
    <div className="work-panel-compact-actions">
      <label className="check-label"><input type="checkbox" checked={draft.reviewed} disabled={disabled}
        onChange={event=>edit({reviewed:event.target.checked})}/>مراجع</label>
      {canEdit && <button type="submit" className="button button-primary button-compact"
        disabled={disabled||!dirty||conflict}>{busy?"جارٍ التنفيذ…":"حفظ"}</button>}
      {canEdit && (dirty||conflict) && <button type="button" className="button button-secondary button-compact"
        disabled={disabled} onClick={()=>void reloadSaved()}>{conflict?"تحميل القيم الحديثة":"استرجاع المحفوظ"}</button>}
    </div>
    {error && <Notice tone="error">{error}</Notice>}
    {saved && <small role="status">حُفظ كرت الصنف.</small>}
  </form>;
}
