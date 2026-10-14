import type { PoolClient } from "pg";
import {
  pageReferenceHref, pageByKey,
  type MemoLinksInput, type MemoLinkedView,
  type MemoPageReference, type MemoVisibleReference, type MemoVisibleEntity,
  type User,
} from "../../../../packages/contracts/src/index.ts";
import { HttpError, missing } from "../errors.ts";
import { directoryEntries, resolvePage } from "./pages.ts";

// Expose link metadata only if the viewer can presently open the destination.
// No raw IDs, labels, or external URLs leak for hidden item/account references.
async function visiblePage(client:PoolClient,user:User,companyId:number,
  value: MemoPageReference | null):Promise<MemoVisibleReference|null> {
  if(!value) return null;
  try {
    const resolved=await resolvePage(client,user,{
      pageKey:value.pageKey,companyId,recordId:value.recordId,
    });
    return {pageKey:value.pageKey,recordId:value.recordId,
      label:resolved.title,href:pageReferenceHref(resolved.reference)};
  } catch(error) {
    if(error instanceof HttpError && [400,403,404].includes(error.status)) return null;
    throw error;
  }
}
async function allowed(client:PoolClient,user:User,companyId:number,pageKey:string) {
  const entries=await directoryEntries(client,user,companyId);
  return !!entries.find(e=>e.key===pageKey)?.actionAccess.view;
}
async function linkedEntity(client:PoolClient,user:User,companyId:number,
  id:number|null,kind:"item"|"account"):Promise<MemoVisibleEntity|null> {
  if(id===null) return null;
  const page=kind==="item"?"company.item-card":"company.accounts";
  if(!await allowed(client,user,companyId,page) ||
    (kind==="item" && !await allowed(client,user,companyId,"company.items")))
    return null;
  const row=(await client.query(
    kind==="item"
    ? "SELECT id,code,name FROM items WHERE company_id=$1 AND id=$2"
    : "SELECT id,code,name FROM accounts WHERE company_id=$1 AND id=$2",
    [companyId,id],
  )).rows[0];
  if(!row) return null;
  return {id:row.id,label:`${row.code} — ${row.name}`,
    href:pageReferenceHref({
      pageKey:page,companyId,
      recordId:kind==="item"?id:null,
    })};
}
export async function validateMemoLinks(
 client:PoolClient,user:User,companyId:number,input:MemoLinksInput,
) {
 for(const reference of [input.followPage,input.referencePage]){
   if(!reference) continue;
   if(!pageByKey(reference.pageKey) || !reference.pageKey.startsWith("company."))
     throw new HttpError(400,"invalid_reference","اختر صفحة مسجلة في دليل صفحات الشركة");
   // Full record access and invoice-kind verification are performed here.
   await resolvePage(client,user,{
     pageKey:reference.pageKey,companyId,recordId:reference.recordId,
   });
 }
 for(const [kind,entityId] of [["item",input.itemId],["account",input.accountId]] as const){
   if(entityId===null) continue;
   if(!await linkedEntity(client,user,companyId,entityId,kind))
     throw new HttpError(403,"linked_access","لا تملك صلاحية السجل المرتبط، أو أنه غير موجود في الشركة");
 }
}
export async function memoLinkView(client:PoolClient,user:User,companyId:number,memoId:number):Promise<MemoLinkedView> {
 const row=(await client.query(
  "SELECT * FROM memo_links WHERE company_id=$1 AND memo_id=$2",
  [companyId,memoId]
 )).rows[0];
 if(!row) missing("بيانات ارتباط المذكرة غير موجودة");
 const followRaw=row.follow_page_key?{pageKey:row.follow_page_key,recordId:row.follow_record_id}:null;
 const referenceRaw=row.reference_page_key?{pageKey:row.reference_page_key,recordId:row.reference_record_id}:null;
 const [followPage,referencePage,item,account]=await Promise.all([
   visiblePage(client,user,companyId,followRaw),
   visiblePage(client,user,companyId,referenceRaw),
   linkedEntity(client,user,companyId,row.item_id,"item"),
   linkedEntity(client,user,companyId,row.account_id,"account"),
 ]);
 const changes=(await client.query(
   "SELECT revision,actor_name,created_at FROM memo_link_changes WHERE company_id=$1 AND memo_id=$2 ORDER BY revision,id",
   [companyId,memoId],
 )).rows.map(c=>({revision:c.revision,actorName:c.actor_name,createdAt:c.created_at.toISOString()}));
 return {revision:row.revision,followPage,referencePage,item,account,
   hiddenFollowPage:!!followRaw&&!followPage,hiddenReferencePage:!!referenceRaw&&!referencePage,
   hiddenItem:row.item_id!==null&&!item,hiddenAccount:row.account_id!==null&&!account,
   changes};
}
export const memoLinksSnapshot=(row:any):MemoLinksInput=>({
 followPage:row.follow_page_key?{pageKey:row.follow_page_key,recordId:row.follow_record_id}:null,
 referencePage:row.reference_page_key?{pageKey:row.reference_page_key,recordId:row.reference_record_id}:null,
 itemId:row.item_id,accountId:row.account_id,
});
