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
  const root="/companies/"+companyId+"/questions";
  const categories=await api<{items:{category:string}[]}>(root+"/categories");
  await shareAuthorizedRead(root+"/categories",categories);
  for (const {category} of categories.items.slice(0,20)) {
    const key="questions";
    const state=await sharedProgress(companyId,key,userId);
    if (state?.complete) return;
    const url=root+"?"+new URLSearchParams({page:"1",pageSize:"20",
      q:"",category,status:"active"});
    try {
      const list=await api<Page>(url);
      await shareAuthorizedRead(url,list);
      // The category index is shared but individual user answer counts are not.
    }catch { /* Read access may change while the device is open. */ }
  }
}
