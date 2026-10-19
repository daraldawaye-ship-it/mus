import { useMemo,useState } from "react";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import type { CompanyContext,EmployeePosition } from "../../../../packages/contracts/src/index.ts";
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
 async function reset() {
   if(!resource.policy||busy)return;
   setBusy(true);setError("");setSuccess("");
   try{
     await api(base,{method:"DELETE",body:{revision:resource.policy.revision}});
     setView([]);setEdit([]);onSaved();
     setSuccess("أُعيد العنصر إلى صلاحيات النظام القائمة.");
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
       }} disabled={busy}/>
     <EmployeePositionPicker label="من يمكنه التعديل" value={edit}
       onChange={next=>{
         setEdit(next);
         setView(current=>[...new Set([...current,...next])]);
         setSuccess("");
       }} disabled={busy}/>
   </div>
   {error&&<Notice tone="error">{error}</Notice>}
   {success&&<Notice tone="success">{success}</Notice>}
   <div className="form-actions">
     <Button disabled={busy} onClick={()=>void save()}>
       {busy?"جارٍ الحفظ…":"حفظ صلاحيات العنصر"}
     </Button>
     <Button variant="secondary" disabled={busy} onClick={clean}>إلغاء التعديلات</Button>
     {resource.policy&&<Button variant="secondary" disabled={busy}
       onClick={()=>void reset()}>إعادة إلى الإعداد الافتراضي</Button>}
   </div>
   <p className="muted">
     {resource.policy
       ?"حُفظ اختيار الصفات لهذا العنصر. الصلاحيات القديمة تظل سارية حتى ربط الحقل أو العملية بالتفويض المركزي واختبارها."
       :"لم يُخصص هذا العنصر بعد؛ الصلاحيات القديمة ما زالت سارية دون تغيير."}
   </p>
 </Card>;
}
export function CentralAccessPage({context}:{context:CompanyContext}) {
 const companyId=context.company.id;
 const {user}=useSession();
 const client=useQueryClient();
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
     description="جميع التعريفات ثابتة برمجيًا. اختر عنصرًا، ثم صفات الموظفين التي يمكنها الاطلاع عليه والتي يمكنها تعديله داخل الشركة."/>
   <Notice>
     هذه هي مرحلة إنشاء الدليل وتخزين إعدادات الصفات. الصلاحيات التشغيلية الحالية لا تتغير
     بمجرد حفظ اختيار جديد هنا؛ سيتم ربط كل حقل وزر وخادم بالصلاحيات المركزية تدريجيًا
     بعد اختبارات منع تجاوز الصلاحيات. لا يمنح المركز الآن صلاحيات إضافية.
   </Notice>
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
         {filtered.map(resource=><button type="button" key={resource.key}
           className={`central-access-entry ${selected===resource.key?"selected":""}`}
           onClick={()=>setSelected(resource.key)}>
           <span><strong>{resource.name}</strong>
             <small>{resource.section} — {kindLabels[resource.kind]}</small></span>
           <span>{resource.policy?"محدد":"افتراضي"}</span>
         </button>)}
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
