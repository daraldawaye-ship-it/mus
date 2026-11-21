import { useEffect,useId,useRef,useState } from "react";
import {useQuery} from "@tanstack/react-query";
import {Search} from "lucide-react";
import type {PageEntry,User} from "../../../packages/contracts/src/index";
import {api} from "./api";
import {canSearchDockUsers,dockUserSearchNames,dockUserSearchPath} from "./dock-user-search";

export function WorkPanelUserSearch({user,pages}:{user:User;pages?:PageEntry[]}) {
  const allowed=canSearchDockUsers(user,pages);
  const [input,setInput]=useState("");
  const [focused,setFocused]=useState(false);
  const [path,setPath]=useState<string|null>(null);
  const field=useRef<HTMLInputElement>(null);
  const resultsId=useId();
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
  return <section className="work-panel-tool-card work-panel-user-container" aria-label="بحث عن مستخدم">
    <div className="user-menu-entity-section" onFocus={()=>setFocused(true)}
      onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false);}}>
      <label className="user-menu-entity-input-wrap has-field-label">
        <Search size={15} aria-hidden="true" />
        <span className="user-menu-entity-field-label">بحث عن مستخدم</span>
        <input type="search" ref={field} value={input} maxLength={100} autoComplete="off"
          aria-controls={visible?resultsId:undefined} onChange={event=>{setInput(event.currentTarget.value);setFocused(true);}}
          onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();setFocused(false);}}} />
      </label>
      {visible&&<div id={resultsId}>
        {!currentRequest || result.isPending ? <small className="muted" role="status">جارٍ البحث…</small>
          : result.isError ? <small role="status">تعذّر البحث عن المستخدمين.</small>
          : result.data?.length ? <ul className="work-panel-page-results" aria-label="المستخدمون المطابقون">
            {result.data.map(row=><li key={row.id}><button type="button" className="user-menu-entity-choice"
              onClick={()=>{setInput(row.name);field.current?.focus();setFocused(false);}}>
              <span>{row.name}</span>
            </button></li>)}
          </ul> : <small className="muted" role="status">لا يوجد مستخدم مطابق.</small>}
      </div>}
    </div>
  </section>;
}
