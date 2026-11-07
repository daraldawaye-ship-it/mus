import { useMemo,useState } from "react";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import {useNavigate} from "react-router-dom";
import {startEmployeePreview} from "../employee-preview-mode";
import { employeePositions,employeePositionLabels,type CompanyContext,type EmployeePosition } from "../../../../packages/contracts/src/index.ts";
import { api,useSession } from "../api";
import { Button,Card,Field,Notice,PageHeader,Select } from "../ui";
import { EmployeePositionPicker } from "../EmployeePositionPicker";
import { errorMessage } from "../phase2";

type ResourceKind="page"|"field"|"button"|"permission"|"control";
type Position={key:EmployeePosition;label:string};
type Policy={key:string;viewPositions:EmployeePosition[];editPositions:EmployeePosition[];
  revision:number;updatedAt:string};
type Resource={key:string;name:string;section:string;kind:ResourceKind;
  description:string;integrated:boolean;policy:Policy|null};
type Response={positions:Position[];resources:Resource[]};
const kindLabels:Record<ResourceKind,string>={
 page:"صفحة",field:"حقل",button:"زر / عملية",permission:"صلاحية",
 control:"خيار الكنترول",
};

function CentralPositionField({resource,companyId,dimension,onSaved}:{
 resource:Resource;companyId:number;dimension:"view"|"edit";onSaved:()=>Promise<unknown>;
}) {
 const [open,setOpen]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const positions=dimension==="view"
   ? resource.policy?.viewPositions??[]:resource.policy?.editPositions??[];
 const selected=positions.length
   ? positions.map(p=>employeePositionLabels[p]).join("، "):"المالك فقط";
 async function toggle(position:EmployeePosition) {
   if(busy)return;
   const next=positions.includes(position)
     ? positions.filter(p=>p!==position):[...positions,position];
   const viewPositions=dimension==="view"
     ? next:[...new Set([...(resource.policy?.viewPositions??[]),...next])];
   const editPositions=dimension==="edit"
     ? next:(resource.policy?.editPositions??[]).filter(p=>viewPositions.includes(p));
   setBusy(true);setError("");
   try {
     await api("/companies/"+companyId+"/central-access/"+encodeURIComponent(resource.key),{
       method:"PUT",body:{viewPositions,editPositions,revision:resource.policy?.revision??null},
     });
     await onSaved();
   } catch(reason) {setError(errorMessage(reason));}
   finally {setBusy(false);}
 }
 return <div className="central-inline-field">
   <button type="button" className="central-inline-trigger" disabled={busy}
     title={dimension==="view"?"صفات عرض العنصر":"صفات تعديل العنصر"}
     aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
     <small>{dimension==="view"?"العرض":"التعديل"}</small>
     <span>{busy?"جارٍ الحفظ…":selected}</span>
   </button>
   {open&&<div className="central-inline-positions">
     <p>اختر صفات {dimension==="view"?"العرض":"التعديل"} (الفراغ للمالك فقط)</p>
     {employeePositions.map(position=><label key={position.key} className="central-inline-choice">
       <input type="checkbox" disabled={busy} checked={positions.includes(position.key)}
         onChange={()=>void toggle(position.key)}/>
       {position.label}
     </label>)}
     {error&&<Notice tone="error">{error}</Notice>}
     <button type="button" className="button button-secondary button-compact"
       onClick={()=>setOpen(false)}>إغلاق</button>
   </div>}
 </div>;
}

function CentralResourceEditor({
 resource,companyId,onSaved,
}:{resource:Resource;companyId:number;onSaved:()=>void}) {
 const [view,setView]=useState<EmployeePosition[]>(resource.policy?.viewPositions??[]);
 const [edit,setEdit]=useState<EmployeePosition[]>(resource.policy?.editPositions??[]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [success,setSuccess]=useState("");
 const clean=()=>{setView(resource.policy?.viewPositions??[]);
   setEdit(resource.policy?.editPositions??[]);};
 const base=`/companies/${companyId}/central-access/${encodeURIComponent(resource.key)}`;
 async function save() {
   if(busy)return;
   setBusy(true);setError("");setSuccess("");
   try {
     await api(base,{method:"PUT",body:{
       viewPositions:view,editPositions:edit,revision:resource.policy?.revision??null,
     }});
     onSaved();setSuccess("تم حفظ صفات الاطلاع والتعديل لهذه الشركة.");
   }catch(reason){setError(errorMessage(reason))}
   finally{setBusy(false)}
 }
 return <Card title={resource.name}>
   <div className="central-access-summary">
     <span>{kindLabels[resource.kind]} / {resource.section}</span>
     <code dir="ltr">{resource.key}</code>
     {resource.description&&<p>{resource.description}</p>}
   </div>
   <div className="central-access-editor">
     <EmployeePositionPicker label="من يمكنه الاطلاع" value={view}
       onChange={next=>{
         setView(next);
         setEdit(current=>current.filter(p=>next.includes(p)));
         setSuccess("");
       }} disabled={busy} allowBaseRemoval/>
     <EmployeePositionPicker label="من يمكنه التعديل" value={edit}
       onChange={next=>{
         setEdit(next);
         setView(current=>[...new Set([...current,...next])]);
         setSuccess("");
       }} disabled={busy} allowBaseRemoval/>
   </div>
   {error&&<Notice tone="error">{error}</Notice>}
   {success&&<Notice tone="success">{success}</Notice>}
   <div className="form-actions">
     <Button disabled={busy} onClick={()=>void save()}>
       {busy?"جارٍ الحفظ…":"حفظ صلاحيات العنصر"}
     </Button>
     <Button variant="secondary" disabled={busy} onClick={clean}>إلغاء التعديلات</Button>

   </div>
   <p className="muted">
     {resource.kind==="page"
       ?"فتح صفحات الشركة يخضع الآن للصفات المحددة، مع بقاء شروط إجراءات الحفظ والترحيل الأصلية."
       :"تُحفظ اختيارات هذا العنصر؛ الحقول والأزرار التي لم تُربط بالخادم لا تغيّر صلاحيات التشغيل بعد."}
   </p>
 </Card>;
}
export function CentralAccessPage({context}:{context:CompanyContext}) {
 const companyId=context.company.id;
 const {user}=useSession();
 const client=useQueryClient();
 const navigate=useNavigate();
 const [previewEmployee,setPreviewEmployee]=useState("");
 const [previewBusy,setPreviewBusy]=useState(false);
 const [previewError,setPreviewError]=useState("");
 const targets=useQuery({
   queryKey:["company-employee-preview-targets",user?.id,companyId],
   queryFn:({signal})=>api<{
     employees:Array<{employeeId:number;employeeName:string;
       user:import("../../../../packages/contracts/src/index.ts").User}>
   }>(`/companies/${companyId}/access-preview/targets`,{signal}),
   enabled:!!user?.owner,
   staleTime:30000,
 });
 async function activateEmployeePreview(){
   const target=targets.data?.employees.find(e=>String(e.employeeId)===previewEmployee);
   if(!target || previewBusy)return;
   setPreviewBusy(true);setPreviewError("");
   try{
     const snapshot=await api<{pages:Array<{key:string;href:string}>}>(
       `/companies/${companyId}/access-preview/${target.employeeId}/pages`);
     const destination=snapshot.pages.find(p=>p.key==="company.overview")?.href
       ??snapshot.pages[0]?.href??`/companies/${companyId}`;
     await client.cancelQueries();
     client.clear();
     startEmployeePreview({companyId,employeeId:target.employeeId,
       employeeName:target.employeeName,user:target.user});
     navigate(destination);
   }catch(reason){setPreviewError(errorMessage(reason));}
   finally{setPreviewBusy(false);}
 }
 const query=useQuery({
   queryKey:["central-access",user?.id,companyId],
   queryFn:({signal})=>api<Response>(`/companies/${companyId}/central-access`,{signal}),
   staleTime:10000,
 });
 const [text,setText]=useState("");
 const [section,setSection]=useState("");
 const [kind,setKind]=useState("");
 const [onlyConfigured,setOnlyConfigured]=useState(false);
 const [selected,setSelected]=useState<string|null>(null);
 const items=query.data?.resources??[];
 const sections=useMemo(()=>[...new Set(items.map(x=>x.section))].sort(),[items]);
 const filtered=useMemo(()=>items.filter(item=>{
   const needle=text.trim().toLocaleLowerCase("ar");
   return (!needle||
       `${item.name} ${item.key} ${item.section} ${item.description}`.toLocaleLowerCase("ar").includes(needle))
     && (!section||item.section===section)
     && (!kind||item.kind===kind)
     && (!onlyConfigured||!!item.policy);
 }),[items,text,section,kind,onlyConfigured]);
 const active=items.find(x=>x.key===selected)??null;
 if(!context.general)return <Notice tone="warning">تعديل مركز الصلاحيات للمالك أو المدير العام.</Notice>;
 return <>
   <PageHeader title="مركز الصلاحيات وخيارات النظام"
     description="حقل للعرض وحقل للتعديل لكل عنصر. الحقل الفارغ للمالك وحده؛ وصفة موظف تسمح لجميع الموظفين."/>
   <Notice>
     تُطبق صفات عرض صفحات الشركة من هذا المركز في القائمة وفتح الروابط والخادم،
     ولا تُمنح صلاحيات جديدة لتسجيل المبالغ أو ترحيل الفواتير. ربط الحقول والأزرار الأخرى
     بالخادم مستقل ولا يتم تجاوز صلاحيات الأعمال القديمة.
   </Notice>
   {user?.owner&&<Card title="تصفح بصلاحيات موظف — للمالك فقط">
     <p className="muted">اختبر القوائم والصفحات والبيانات التي يراها الموظف فعلًا. المعاينة مؤقتة للقراءة فقط، ولا تُبدّل حسابك أو كلمة مرور الموظف أو صلاحياته.</p>
     <div className="central-preview-selector">
       <Select label="اختر الموظف" value={previewEmployee}
         disabled={previewBusy||targets.isPending}
         onChange={event=>setPreviewEmployee(event.target.value)}>
         <option value="">اختر موظفًا من الشركة</option>
         {targets.data?.employees.map(e=><option key={e.employeeId}
           value={String(e.employeeId)}>{e.employeeName} — {e.user.displayName}</option>)}
       </Select>
       <Button disabled={previewBusy||!previewEmployee||targets.isPending}
         onClick={()=>void activateEmployeePreview()}>
         {previewBusy?"جارٍ فتح المعاينة…":"تصفح بصلاحيات الموظف"}
       </Button>
     </div>
     {targets.error&&<Notice tone="error">{errorMessage(targets.error)}</Notice>}
     {previewError&&<Notice tone="error">{previewError}</Notice>}
     <small className="muted">يعرض الخادم صلاحيات العضوية الحالية. أثناء المعاينة يُمنع حفظ الفواتير أو تعديل السجلات أو الترحيل أو الحذف. ويمكن العودة بنقرة واحدة من الشريط العلوي.</small>
   </Card>}
   {query.error&&<Notice tone="error">{errorMessage(query.error)}</Notice>}
   {query.isPending&&<Notice>جارٍ تحميل دليل الصلاحيات…</Notice>}
   <div className="central-access-layout">
     <Card title="دليل العناصر والبحث">
       <div className="central-access-filters">
         <Field type="search" label="بحث باسم الحقل أو الزر أو الرمز" value={text}
           onChange={e=>setText(e.target.value)} placeholder="مثال: سعر الشراء"/>
         <Select label="المجموعة" value={section} onChange={e=>setSection(e.target.value)}>
           <option value="">كل المجموعات</option>
           {sections.map(x=><option value={x} key={x}>{x}</option>)}
         </Select>
         <Select label="نوع العنصر" value={kind} onChange={e=>setKind(e.target.value)}>
           <option value="">جميع الأنواع</option>
           {Object.entries(kindLabels).map(([value,label])=>
             <option value={value} key={value}>{label}</option>)}
         </Select>
         <label className="check-label">
           <input type="checkbox" checked={onlyConfigured}
             onChange={e=>setOnlyConfigured(e.target.checked)}/>
           عرض العناصر المحددة صلاحياتها فقط
         </label>
       </div>
       <p className="muted">عدد النتائج: {filtered.length} من {items.length} عنصر.</p>
       <div className="central-access-list">
         {filtered.map(resource=><div key={resource.key}
           className={`central-access-entry ${selected===resource.key?"selected":""}`}>
           <button type="button" className="central-access-entry-name"
             onClick={()=>setSelected(resource.key)}>
             <strong>{resource.name}</strong>
             <small>{resource.section} — {kindLabels[resource.kind]}</small>
           </button>
           <CentralPositionField resource={resource} companyId={companyId}
             dimension="view"
             onSaved={()=>client.invalidateQueries({queryKey:["central-access",user?.id,companyId]})}/>
           <CentralPositionField resource={resource} companyId={companyId}
             dimension="edit"
             onSaved={()=>client.invalidateQueries({queryKey:["central-access",user?.id,companyId]})}/>
         </div>)}
         {filtered.length===0&&!query.isPending&&<p>لا توجد نتائج.</p>}
       </div>
     </Card>
     <div>
       {active?<CentralResourceEditor key={`${companyId}:${active.key}:${active.policy?.revision??0}`}
         companyId={companyId} resource={active}
         onSaved={()=>void client.invalidateQueries({queryKey:["central-access",user?.id,companyId]})}/>
         :<Card title="اختيار عنصر"><p>اختر أي حقل أو زر أو صفحة من القائمة لعرض صلاحيات الاطلاع والتعديل.</p></Card>}
     </div>
   </div>
 </>;
}
