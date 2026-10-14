import { useState } from "react";
import { pageDefinitions, type MemoLinksInput, type MemoPageReference, type MemoLinkedView } from "../../../packages/contracts/src/index";
import { usePageDirectory } from "./page-directory";
import { ServerLookup } from "./phase2";
import { Field, Select } from "./ui";

export const emptyMemoLinks = ():MemoLinksInput => ({
 followPage:null,referencePage:null,itemId:null,accountId:null,
});
type LookupRecord={id:number;name:string};
const pickable = pageDefinitions.filter(p => p.scope==="company" &&
  (!p.record || ["invoice","item","financial-document"].includes(p.record)) &&
  p.key!=="company.memo-detail");
export function MemoLinksEditor({
  companyId,value,onChange,disabled=false,existing=null,
}:{
  companyId:number;value:MemoLinksInput;onChange:(value:MemoLinksInput)=>void;
  disabled?:boolean;existing?:MemoLinkedView|null;
}) {
 const directory=usePageDirectory(companyId);
 const list=pickable.filter(p=>directory.data?.find(e=>e.key===p.key)?.actionAccess.view);
 const [recordSearch, setRecordSearch] = useState<Record<string,LookupRecord|null>>({});
 function pageField(field:"followPage"|"referencePage",label:string) {
   const selected=value[field];
   const definition=pickable.find(p=>p.key===selected?.pageKey);
   function update(next:MemoPageReference|null) {
     onChange({...value,[field]:next});
     setRecordSearch(pr=>({...pr,[field]:null}));
   }
   return <div className="form-stack">
     <Select label={label} value={selected?.pageKey??""} disabled={disabled || directory.isLoading}
       onChange={event=>update(event.target.value?{pageKey:event.target.value,recordId:null}:null)}>
       <option value="">بدون ارتباط</option>
       {list.map(page=><option key={page.key} value={page.key}>
         {page.name}{page.type==="report"?" (تقرير)":""}
       </option>)}
     </Select>
     {definition?.record && (
       <ServerLookup<LookupRecord>
         key={field+definition.key}
         companyId={companyId}
         resource={`/companies/${companyId}/memos/link-records?pageKey=${encodeURIComponent(definition.key)}`}
         label={`السجل المحدد — ${label}`}
         value={recordSearch[field] ?? (selected?.recordId
           ? {id:selected.recordId,name:`سجل #${selected.recordId}`} : null)}
         onChange={record=>{
           setRecordSearch(pr=>({...pr,[field]:record}));
           onChange({...value,[field]:{...selected!,recordId:record?.id??null}});
         }}
         display={record=>record.name} disabled={disabled} required
         emptyLabel="اختر سجلًا محددًا"/>
     )}
   </div>;
 }
 const [item,setItem]=useState<LookupRecord|null>(existing?.item?{
   id:existing.item.id,name:existing.item.label}:null);
 const [account,setAccount]=useState<LookupRecord|null>(existing?.account?{
   id:existing.account.id,name:existing.account.label}:null);
 return <div className="form-stack">
   <p className="muted">الربط اختياري؛ لا يمنح المستلم صلاحيات إضافية. تُفحص صلاحية فتح كل رابط من جديد.</p>
   {pageField("followPage","صفحة المتابعة — مكان التنفيذ")}
   {pageField("referencePage","الصفحة أو التقرير المرجعي")}
   <ServerLookup<LookupRecord> companyId={companyId}
     resource={`/companies/${companyId}/memos/link-items`}
     label="الصنف المرتبط (اختياري)"
     value={item ?? (value.itemId?{id:value.itemId,name:`صنف #${value.itemId}`}:null)}
     onChange={record=>{setItem(record);onChange({...value,itemId:record?.id??null});}}
     display={record=>record.name} disabled={disabled}/>
   <ServerLookup<LookupRecord> companyId={companyId}
     resource={`/companies/${companyId}/memos/link-accounts`}
     label="الحساب المرتبط (اختياري)"
     value={account ?? (value.accountId?{id:value.accountId,name:`حساب #${value.accountId}`}:null)}
     onChange={record=>{setAccount(record);onChange({...value,accountId:record?.id??null});}}
     display={record=>record.name} disabled={disabled}/>
 </div>;
}
