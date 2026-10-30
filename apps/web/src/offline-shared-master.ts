import { api } from "./api";
import { sharedProgress, saveSharedProgress, shareAuthorizedRead } from "./offline-shared";
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
      const already=await sharedProgress(companyId,group,userId);
      if (already?.complete) continue;
      const firstPath=pathAt(1);
      const first=await api<Page>(firstPath);
      await shareAuthorizedRead(firstPath,first);
      const previous=await sharedProgress(companyId,group,userId);
      if (previous?.complete) continue;
      for(let page=previous?.page??1;remaining>0;page++) {
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
