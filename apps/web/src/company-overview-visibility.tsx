import {useEffect,useRef,useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {pageHref,type PageEntry} from "../../../packages/contracts/src/index";
import {api,useScopeGuard,useSession} from "./api";
import {errorMessage} from "./phase2";
import {Button} from "./ui";

export function canConfigureCompanyShortcut(entry:PageEntry,companyId:number) {
  return Number.isSafeInteger(companyId)&&companyId>0&&entry.scope==="company"&&entry.key!=="company.pages"&&!entry.record&&
    !!entry.href&&entry.href===pageHref(entry,companyId);
}

export function useCompanyOverviewVisibility(companyId:number|undefined) {
  const {user:pageUser,employeePreview}=useSession();
  const userOwner=!!pageUser?.owner&&!employeePreview;
  const overviewClient=useQueryClient();
  const overviewGuard=useScopeGuard(`company-overview-visibility:${companyId??"public"}`);
  const [overviewSaving,setOverviewSaving]=useState<string|null>(null);
  const [overviewFailure,setOverviewFailure]=useState("");
  const overviewInFlight=useRef<string|null>(null);
  useEffect(()=>{overviewInFlight.current=null;setOverviewSaving(null);setOverviewFailure("");},[companyId,pageUser?.id]);
  const toggleOverview=async(entry:PageEntry)=>{
    if(!companyId||!userOwner||!canConfigureCompanyShortcut(entry,companyId)||
       overviewInFlight.current||!overviewGuard.isCurrent())return;
    const pending=`${companyId}:${entry.key}`;
    overviewInFlight.current=pending;
    setOverviewSaving(entry.key);setOverviewFailure("");
    const showOnCompanyOverview=entry.showOnCompanyOverview===false;
    try{
      await api<{pageKey:string;showOnCompanyOverview:boolean}>(
        `/companies/${companyId}/page-catalog/${encodeURIComponent(entry.key)}/overview-visibility`,
        {method:"PATCH",body:{showOnCompanyOverview},signal:overviewGuard.signal});
      await overviewClient.invalidateQueries({queryKey:["page-directory",pageUser?.id,companyId]});
      await overviewClient.invalidateQueries({queryKey:["list",pageUser?.id,"page-directory"]});
    }catch(error){
      if(overviewGuard.isCurrent())setOverviewFailure(errorMessage(error));
    }finally{
      if(overviewInFlight.current===pending)overviewInFlight.current=null;
      if(overviewGuard.isCurrent())setOverviewSaving(null);
    }
  };
  const overviewControl=(entry:PageEntry)=>!userOwner||!companyId ? null : entry.key==="company.pages" ? <span className="muted">رابط ثابت</span>
    : entry.scope==="public" ? <span className="muted">ليست من صفحات الشركة</span>
    : !canConfigureCompanyShortcut(entry,companyId) ? <span aria-label="لا يوجد رابط مباشر">—</span>
    : <Button type="button" variant="secondary" size="compact"
        disabled={overviewSaving!==null}
        aria-label={(entry.showOnCompanyOverview===false?"إظهار ":"إخفاء ")+entry.name+" من واجهة الشركة"}
        onClick={()=>void toggleOverview(entry)}>
        {overviewSaving===entry.key?"جارٍ الحفظ…":
          entry.showOnCompanyOverview===false?"إظهار من واجهة الشركة":"إخفاء من واجهة الشركة"}
      </Button>;
  return {overviewControl,overviewFailure};
}
