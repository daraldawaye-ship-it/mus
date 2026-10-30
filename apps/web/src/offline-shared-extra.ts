import { api } from "./api";
import { shareAuthorizedRead, sharedProgress, saveSharedProgress } from "./offline-shared";

type Page = { items:Record<string,unknown>[];total?:number };
export async function refreshSharedCompositions(userId:number,companyId:number) {
  const root="/companies/"+companyId+"/item-compositions";
  const url=(page:number)=>root+"?page="+page+"&pageSize=100&active=true";
  const first=await api<Page>(url(1));
  await shareAuthorizedRead(url(1),first);
  const saved=await sharedProgress(companyId,"item-compositions",userId);
  if (saved?.complete) return;
  const page=saved?.page??1;
  const response=page===1?first:await api<Page>(url(page));
  await shareAuthorizedRead(url(page),response);
  const complete=response.items.length<100||(typeof response.total==="number"&&page*100>=response.total);
  await saveSharedProgress(companyId,"item-compositions",userId,page+1,complete);
}
export async function refreshSharedQuestions(userId:number,companyId:number) {
  const interrupted=()=>!navigator.onLine||document.visibilityState==="hidden";
  for (const [id,root] of [
    [0,"/questions"],[companyId,"/companies/"+companyId+"/questions"],
  ] as const) {
    if (interrupted()) return;
    let categories: {items:{category:string}[]};
    try {
      categories=await api(root+"/categories");
      await shareAuthorizedRead(root+"/categories",categories);
    }catch { continue; }
    const saved=await sharedProgress(id,"questions",userId);
    if(saved?.complete) continue;
    // The cursor advances across categories and pages. Fetch at most
    // eight pages per visible pass, continuing later from the saved cursor.
    let position=saved?.page??1;
    for(let budget=0;budget<8;budget++) {
      if(!navigator.onLine||document.visibilityState==="hidden") return;
      const categoryIndex=Math.floor((position-1)/10000);
      const page=((position-1)%10000)+1;
      if(categoryIndex>=categories.items.length) {
        await saveSharedProgress(id,"questions",userId,position,true);
        break;
      }
      const category=categories.items[categoryIndex].category;
      const url=root+"?"+new URLSearchParams({
        page:String(page),pageSize:"20",q:"",category,status:"active",
      });
      try {
        const list=await api<Page>(url);
        await shareAuthorizedRead(url,list);
        const complete=list.items.length<20 ||
          (typeof list.total==="number"&&page*20>=list.total);
        position=complete?(categoryIndex+1)*10000+1:position+1;
        const allDone=complete&&categoryIndex+1>=categories.items.length;
        await saveSharedProgress(id,"questions",userId,position,allDone);
        if(allDone) break;
      }catch { break; }
    }
  }
}
