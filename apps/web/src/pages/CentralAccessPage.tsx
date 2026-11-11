import { useMemo,useRef,useState } from "react";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import {useNavigate} from "react-router-dom";
import {startEmployeePreview} from "../employee-preview-mode";
import { employeePositions,employeePositionLabels,permissionKeys,permissionLabels,type CompanyContext,type EmployeePosition,type Permission } from "../../../../packages/contracts/src/index.ts";
import { api,useScopeGuard,useSession } from "../api";
import { Button,Card,Field,Notice,PageHeader,Select } from "../ui";
import { EmployeePositionPicker } from "../EmployeePositionPicker";
import { errorMessage } from "../phase2";

type ResourceKind="page"|"field"|"button"|"permission"|"control";
type Position={key:EmployeePosition;label:string};
type Policy={key:string;viewPositions:EmployeePosition[];editPositions:EmployeePosition[];
  revision:number;updatedAt:string};
type Resource={key:string;name:string;section:string;kind:ResourceKind;
  description:string;integrated:boolean;policy:Policy|null};
type PermissionEmployee={id:number;name:string;active:boolean;
 positions:EmployeePosition[];permissions:Permission[];isGeneralManager:boolean;isOwner:boolean};
type Response={positions:Position[];resources:Resource[];permissionEmployees?:PermissionEmployee[]};
const kindLabels:Record<ResourceKind,string>={
 page:"صفحة",field:"حقل",button:"زر / عملية",permission:"صلاحية تشغيل",
 control:"خيار الكنترول",
};

const viewSources:Partial<Record<Permission,Permission[]>>={
 "accounts.view":["accounts.manage"],
 "currencies.view":["currencies.manage"],
 "locations.view":["locations.manage"],
 "items.view":["items.manage"],
 "commerce.view":["commerce.manage"],
 "inventory.view":["inventory.manage","inventory.post"],
 "finance.view":["finance.manage","finance.post"],
};
function resourcePermission(resource:Resource):Permission|null {
 const key=resource.key.slice("permission:".length);
 return resource.kind==="permission" && permissionKeys.includes(key as Permission)
   ? key as Permission : null;
}
function automaticGrant(employee:PermissionEmployee,permission:Permission):string|null {
 if(employee.isOwner)return "متاحة للمالك";
 if(employee.isGeneralManager)return "متاحة للمدير العام";
 if(permission==="finance.own-cashbox.view" && employee.positions.includes("cashier"))
   return "متاحة بصفة أمين صندوق";
 const source=viewSources[permission]?.find(key=>employee.permissions.includes(key));
 return source?`متاحة أيضًا بصلاحية «${permissionLabels[source]}»`:null;
}

function CentralEmployeePermissionEditor({resource,companyId,employees,onSaved}:{
 resource:Resource;companyId:number;employees:PermissionEmployee[]|undefined;
 onSaved:(employee?:PermissionEmployee)=>Promise<unknown>;
}) {
 const permission=resourcePermission(resource);
 const guard=useScopeGuard(`company:${companyId}:central-permission:${resource.key}`);
 const [busyId,setBusyId]=useState<number|null>(null);
 const saveLock=useRef(false);
 const [error,setError]=useState("");
 const [success,setSuccess]=useState("");
 const [search,setSearch]=useState("");
 const filtered=employees?.filter(employee=>
   employee.name.toLocaleLowerCase("ar").includes(search.trim().toLocaleLowerCase("ar")))??[];
 async function toggle(employee:PermissionEmployee,granted:boolean) {
   if(!permission || saveLock.current || employee.isOwner || employee.isGeneralManager)return;
   saveLock.current=true;setBusyId(employee.id);setError("");setSuccess("");
   try {
     const result=await api<{employee:PermissionEmployee}>(
       `/companies/${companyId}/central-access/${encodeURIComponent(resource.key)}/employees/${employee.id}`,{
         method:"PATCH",signal:guard.signal,
         body:{granted,expectedGranted:employee.permissions.includes(permission)},
       });
     if(!guard.isCurrent())return;
     await onSaved(result.employee);
     if(guard.isCurrent())setSuccess(`تم حفظ صلاحية ${employee.name}.`);
   }catch(reason){
     if(guard.isCurrent()){
       setError(errorMessage(reason));
       // Reload after an unknown outcome or a concurrent change before retrying.
       await onSaved();
     }
   }finally{
     saveLock.current=false;
     if(guard.isCurrent())setBusyId(null);
   }
 }
 if(!permission)return <Notice tone="error">تعذر تحديد صلاحية التشغيل.</Notice>;
 return <Card title={resource.name}>
   <p className="muted">
     حدد الموظفين الممنوحين هذه الصلاحية مباشرة. تُحفظ كل علامة فورًا،
     وتظل صلاحيات الصفحات وشروط الإجراءات مطبقة.
   </p>
   <Field type="search" label="بحث عن موظف" value={search}
     onChange={event=>setSearch(event.target.value)} placeholder="اسم الموظف"/>
   {error&&<Notice tone="error">{error}</Notice>}
   {success&&<Notice tone="success">{success}</Notice>}
   {!employees&&<Notice>تعيينات الموظفين غير متاحة الآن. أعد تحميل الصفحة بعد اكتمال التحديث.</Notice>}
   <div className="central-permission-employees">
     {filtered.map(employee=>{
       const automatic=automaticGrant(employee,permission);
       const protectedGrant=employee.isOwner||employee.isGeneralManager;
       const direct=employee.permissions.includes(permission);
       return <div key={employee.id} className="central-permission-employee">
         <label className="check-label">
           <input type="checkbox" checked={protectedGrant||direct}
             disabled={busyId!==null||protectedGrant}
             onChange={event=>void toggle(employee,event.target.checked)}/>
           <span>{employee.name}{!employee.active&&" — غير فعال"}</span>
           {busyId===employee.id&&<small>جارٍ الحفظ…</small>}
         </label>
         <small className="muted">
           {automatic??(direct?"منح مباشر":"بلا منح مباشر")}
           {automatic&&!protectedGrant&&(direct?" · يوجد منح مباشر أيضًا":" · دون منح مباشر")}
           {!employee.active&&" · العضوية غير مفعلة"}
         </small>
       </div>;
     })}
     {employees&&filtered.length===0&&<p className="muted">لا يوجد موظفون مطابقون.</p>}
   </div>
   <p className="muted">إزالة المنح المباشر لا تلغي صلاحية متاحة بسبب صفة الموظف أو صلاحية أخرى.</p>
 </Card>;
}

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
 async function permissionSaved(employee?:PermissionEmployee) {
   if(employee)client.setQueryData<Response>(["central-access",user?.id,companyId],previous=>
     previous?{...previous,permissionEmployees:previous.permissionEmployees?.map(current=>
       current.id===employee.id?employee:current)}:previous);
   await Promise.all([
     client.invalidateQueries({queryKey:["central-access",user?.id,companyId]}),
     client.invalidateQueries({queryKey:["company",user?.id,companyId]}),
     client.invalidateQueries({queryKey:["page-directory",user?.id,companyId]}),
     client.invalidateQueries({queryKey:["list",user?.id,`company:${companyId}:employees`]}),
   ]);
 }
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
     && (!onlyConfigured||!!item.policy||item.kind==="permission");
 }),[items,text,section,kind,onlyConfigured]);
 const active=items.find(x=>x.key===selected)??null;
 if(!context.general)return <Notice tone="warning">تعديل مركز الصلاحيات للمالك أو المدير العام.</Notice>;
 return <>
   <PageHeader title="مركز الصلاحيات وخيارات النظام"
     description="إدارة صلاحيات الصفحات والعمليات من مكان واحد. صفات الصفحة الفارغة تعني المالك فقط؛ وصفة موظف تسمح لجميع الموظفين."/>
   <Notice>
     صلاحيات العمليات مستقلة عن فتح الصفحات. اختر صلاحية تشغيل من القائمة
     لإدارة منح الموظفين الحالية؛ لا يغيّر فتح هذه الصفحة أي صلاحية.
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
           {resource.kind==="permission"
             ? <button type="button" className="central-inline-trigger central-permission-summary"
                 onClick={()=>setSelected(resource.key)}>
                 <small>منح مباشر</small>
                 <span>{query.data?.permissionEmployees
                   ? `${query.data.permissionEmployees.filter(employee=>
                       employee.permissions.includes(resourcePermission(resource)!)).length} موظف — إدارة الموظفين`
                   :"عرض تعيينات الموظفين"}</span>
               </button>
             : <>
                 <CentralPositionField resource={resource} companyId={companyId}
                   dimension="view"
                   onSaved={()=>client.invalidateQueries({queryKey:["central-access",user?.id,companyId]})}/>
                 <CentralPositionField resource={resource} companyId={companyId}
                   dimension="edit"
                   onSaved={()=>client.invalidateQueries({queryKey:["central-access",user?.id,companyId]})}/>
               </>}
         </div>)}
         {filtered.length===0&&!query.isPending&&<p>لا توجد نتائج.</p>}
       </div>
     </Card>
     <div>
       {active?(active.kind==="permission"
         ? <CentralEmployeePermissionEditor key={`${companyId}:${active.key}`}
             companyId={companyId} resource={active} employees={query.data?.permissionEmployees}
             onSaved={permissionSaved}/>
         : <CentralResourceEditor key={`${companyId}:${active.key}:${active.policy?.revision??0}`}
             companyId={companyId} resource={active}
             onSaved={()=>void client.invalidateQueries({queryKey:["central-access",user?.id,companyId]})}/>)
         :<Card title="اختيار عنصر"><p>اختر صفحة أو صلاحية تشغيل أو حقلًا أو زرًا من القائمة لإدارة صلاحياته.</p></Card>}
     </div>
   </div>
 </>;
}
