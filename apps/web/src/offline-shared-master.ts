import { api } from "./api";
import { sharedProgress, saveSharedProgress, shareAuthorizedRead, sharedReferenceRefreshDue } from "./offline-shared";
const sections = [
  ["options:accounts","commerce-options?type=accounts"],
  ["options:branches","commerce-options?type=branches"],
  ["options:locations","commerce-options?type=locations"],
  ["options:currencies","commerce-options?type=currencies"],
  ["doctors","doctors"],["sale-customers","sale-customers"],
  ["branches","branches"],["locations","locations"],
  ["item-shelves","item-shelves"],["accounts","accounts"],
] as const;
type Page = { items: Record<string,unknown>[];total?:number };
/** Each category is shared once per company and device, after current user's
 * server-side permission check. Private answers and accounting balances are
 * stripped by shareAuthorizedRead, never cached as shared raw responses.
 */
export async function downloadSharedReferenceCards(userId:number,companyId:number) {
  let remaining=20;
  const interrupted=()=>!navigator.onLine||document.visibilityState==="hidden";
  for (const [group,resource] of sections) {
    if (interrupted()||remaining<=0) return;
    const pathAt=(page:number)=>{
      const search=new URLSearchParams(resource.split("?")[1]||"");
      search.set("page",String(page));
      search.set("pageSize","100");
      return "/companies/"+companyId+"/"+resource.split("?")[0]+"?"+search;
    };
    try {
      // Revalidate the current user and refresh page one on each visible pass.
      // Full catalog rescans remain limited to once per day.
      const firstPath=pathAt(1);
      const first=await api<Page>(firstPath);
      await shareAuthorizedRead(firstPath,first);
      const previous=await sharedProgress(companyId,group,userId);
      if (!sharedReferenceRefreshDue(previous)) continue;
      for(let page=previous?.complete?1:(previous?.page??1);remaining>0;page++) {
        if(interrupted()) return;
        const path=pathAt(page);
        const data=page===1?first:await api<Page>(path);
        await shareAuthorizedRead(path,data);
        const done=data.items.length<100 ||
          (typeof data.total==="number"&&page*100>=data.total);
        await saveSharedProgress(companyId,group,userId,page+1,done);
        remaining--;
        if(done) break;
      }
    }catch {
      // One user's missing module permission must not block other resources.
    }
  }
}

const doctorSyncing=new Set<string>();
/** Doctor and entity cards must be available before the first invoice goes
 * offline. Download independently of the large item/account catalog and even
 * in an ordinary browser. Never fetch without the signed-in user's server
 * permission; page one grants this group for that user only. */
export async function refreshSharedDoctorDirectory(userId:number,companyId:number):Promise<void> {
  const key=userId+":"+companyId;
  const interrupted=()=>!navigator.onLine || document.visibilityState==="hidden";
  if(!userId || !companyId || interrupted() || doctorSyncing.has(key)) return;
  doctorSyncing.add(key);
  try {
    const root="/companies/"+companyId+"/doctors?";
    const url=(page:number)=>root+new URLSearchParams({
      page:String(page),pageSize:"100",
    });
    const first=await api<Page>(url(1));
    await shareAuthorizedRead(url(1),first);
    const previous=await sharedProgress(companyId,"doctors",userId);
    if(!sharedReferenceRefreshDue(previous))return;
    let page=previous?.complete?1:(previous?.page??1);
    for(let budget=0;budget<6;budget++,page++) {
      if(interrupted())return;
      const result=page===1?first:await api<Page>(url(page));
      await shareAuthorizedRead(url(page),result);
      const complete=result.items.length<100 ||
        (typeof result.total==="number" && page*100>=result.total);
      await saveSharedProgress(companyId,"doctors",userId,page+1,complete);
      if(complete)break;
    }
  } catch {
    // Missing permissions or a disconnected network must not block invoicing.
  } finally { doctorSyncing.delete(key); }
}
