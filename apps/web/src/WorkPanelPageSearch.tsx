import { useId,useState } from "react";
import { Search } from "lucide-react";
import { Link } from "react-router-dom";
import type { PageEntry, User } from "../../../packages/contracts/src/index";
import { findWorkPanelPages } from "./work-panel-search-access";

export function WorkPanelPageSearch({user,companyId,pages,loading,error,currentLabel,currentRoute}:{
  user:User; companyId?:number; pages?:PageEntry[]; loading:boolean; error:boolean; currentLabel:string;currentRoute:string;
}) {
  const [edit,setEdit]=useState<{route:string;value:string}|null>(null);
  const searching=edit?.route===currentRoute;
  const query=searching?edit.value:currentLabel;
  const resultsId=useId();
  const results=findWorkPanelPages(error||!searching?undefined:pages,user,companyId,query);
  return <section className="work-panel-tool-card work-panel-page-container" aria-label="بحث عن صفحة">
    <div className="user-menu-entity-section">
      <label className="user-menu-entity-input-wrap has-field-label">
        <Search size={15} aria-hidden="true" />
        <span className="user-menu-entity-field-label">بحث عن صفحة</span>
        <input type="search" value={query} onChange={event=>setEdit({route:currentRoute,value:event.currentTarget.value})}
          aria-controls={searching&&query.trim()?resultsId:undefined} autoComplete="off" />
      </label>
      {searching&&query.trim()&&<div id={resultsId}>
        {results.length>0 ? <ul className="work-panel-page-results" aria-label="الصفحات المطابقة">
          {results.map(page=><li key={page.key}>
            <Link to={page.href} onClick={()=>setEdit(null)}>{page.name}</Link>
          </li>)}
        </ul> : <small role="status" className="muted">{error ? "تعذّر التحقق من الصفحات المتاحة." :
          loading ? "جارٍ التحقق من الصفحات المتاحة…" : "لا توجد صفحات مطابقة."}</small>}
      </div>}
    </div>
  </section>;
}
