import { lazy,Suspense,useEffect,useId,useRef,useState } from "react";
import {useQuery} from "@tanstack/react-query";
import {Search} from "lucide-react";
import type {PageEntry,User} from "../../../packages/contracts/src/index";
import type {DockReference} from "./dock-table-references";
import {api} from "./api";
import {isDockEntityId} from "./dock-card-access";
import {Button,Dialog,Notice} from "./ui";
const UserCard=lazy(()=>import("./DockUserCardBody").then(module=>({default:module.DockUserCardBody})));
import {canSearchDockUsers,dockUserCollisionIds,dockUserSearchNames,dockUserSearchPath,type DockUserChoice} from "./dock-user-search";

export function WorkPanelUserSearch({user,pages,dockSelection}:{user:User;pages?:PageEntry[];dockSelection?:DockReference}) {
  const allowed=canSearchDockUsers(user,pages);
  const [input,setInput]=useState("");
  const [selected,setSelected]=useState<(DockUserChoice & {showId:boolean})|null>(null);
  const [cardId,setCardId]=useState<number|null>(null);
  const [focused,setFocused]=useState(false);
  const [path,setPath]=useState<string|null>(null);
  const field=useRef<HTMLInputElement>(null);
  const resultsId=useId();
  useEffect(()=>{
    if(!allowed){
      setInput("");setSelected(null);setFocused(false);setPath(null);setCardId(null);
      return;
    }
    if(!dockSelection)return;
    // Employee IDs are tenant-specific; displaying the supplied name does
    // not issue a global user lookup or translate its ID into a user ID.
    setInput(dockSelection.name);
    setSelected(dockSelection.kind==="user" ? {id:dockSelection.id,name:dockSelection.name,showId:false} : null);
    setFocused(false);setPath(null);setCardId(null);
  },[allowed,dockSelection]);
  const current=dockUserSearchPath(input);
  useEffect(()=>{
    if(!allowed || !focused || !current){setPath(null);return;}
    const timer=window.setTimeout(()=>setPath(current),220);
    return ()=>window.clearTimeout(timer);
  },[allowed,focused,current]);
  const visible=allowed&&focused&&!!current;
  const currentRequest=visible&&path===current;
  const result=useQuery({
    queryKey:["work-panel-user-search",user.id,path],
    enabled:currentRequest,
    staleTime:10_000,
    retry:false,
    queryFn:async({signal})=>dockUserSearchNames((await api<{items:Pick<User,"id"|"name"|"displayName">[]}>(
      path!,{signal},
    )).items),
  });
  if(!allowed)return null;
  const verifiedSelection=isDockEntityId(selected?.id)?selected!.id:null;
  const collisionIds=dockUserCollisionIds(currentRequest ? result.data??[] : []);
  return <section className="work-panel-tool-card work-panel-user-container" aria-label="بحث عن مستخدم">
    <div className="user-menu-entity-section" onFocus={()=>setFocused(true)}
      onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false);}}>
      <label className="user-menu-entity-input-wrap has-field-label">
        <Search size={15} aria-hidden="true" />
        <span className="user-menu-entity-field-label">بحث عن مستخدم</span>
        <input type="search" ref={field} value={input} maxLength={100} autoComplete="off"
          aria-controls={visible?resultsId:undefined} onChange={event=>{setInput(event.currentTarget.value);setSelected(null);setCardId(null);setFocused(true);}}
          onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();setFocused(false);}}} />
      </label>
      {selected?.showId && <small className="muted" role="status">المستخدم المحدد <bdi>#{selected.id}</bdi></small>}
      {visible&&<div id={resultsId}>
        {!currentRequest || result.isPending ? <small className="muted" role="status">جارٍ البحث…</small>
          : result.isError ? <small role="status">تعذّر البحث عن المستخدمين.</small>
          : result.data?.length ? <ul className="work-panel-page-results" aria-label="المستخدمون المطابقون">
            {result.data.map(row=>{
              const showId=collisionIds.has(row.id);
              return <li key={row.id}><button type="button" className="user-menu-entity-choice"
                onClick={()=>{setSelected({...row,showId});setInput(row.name);field.current?.focus();setFocused(false);}}>
                <span>{row.name}</span>{" "}{showId && <small className="muted"><bdi>#{row.id}</bdi></small>}
              </button></li>;
            })}
          </ul> : <small className="muted" role="status">لا يوجد مستخدم مطابق.</small>}
      </div>}
      <div className="work-panel-entity-actions">
        <Button size="compact" variant="secondary" disabled={verifiedSelection===null}
          onClick={()=>{setFocused(false);setCardId(verifiedSelection);}}>كرت المستخدم</Button>
      </div>
    </div>
    <Dialog open={verifiedSelection!==null&&cardId===verifiedSelection} title="كرت المستخدم" className="invoice-item-sheet" onClose={()=>setCardId(null)}>
      {verifiedSelection!==null&&cardId===verifiedSelection&&<Suspense fallback={<Notice>جارٍ فتح كرت المستخدم…</Notice>}>
        <UserCard userId={verifiedSelection} actorId={user.id} />
      </Suspense>}
    </Dialog>
  </section>;
}
