import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { PageHeader, Card, Button, Notice } from "../ui";

type Task={
 key:"memo_required"|"composition_review"|"stock_count";
 name:string;description:string;href:string;companyId:number;companyName?:string;
 enabled:boolean;completed:number;required:number;available:number;visible:boolean;
 targetCount:number;periodDays:number;assignedEmployeeIds:number[];followerEmployeeIds:number[];
 revision:number;canControl:boolean;canFollow:boolean;canExecute:boolean;
};
type Employee={id:number;name:string;active:boolean};
type Draft={enabled:boolean;targetCount:number;periodDays:number;assignedEmployeeIds:number[];followerEmployeeIds:number[];revision:number};
const draftOf=(task:Task):Draft=>({
 enabled:task.enabled,targetCount:task.targetCount,periodDays:task.periodDays,
 assignedEmployeeIds:task.assignedEmployeeIds,followerEmployeeIds:task.followerEmployeeIds,
 revision:task.revision
});
const number=(value:number)=>new Intl.NumberFormat("ar-YE").format(value);
function TaskRow({task,employees,onSaved}:{task:Task;employees:Employee[];onSaved:()=>void}) {
 const [expanded,setExpanded]=useState(false);
 const [settingsOpen,setSettingsOpen]=useState(false);
 const [draft,setDraft]=useState<Draft>(()=>draftOf(task));
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [success,setSuccess]=useState("");
 const [candidatesOpen,setCandidatesOpen]=useState(false);
 const candidates=useQuery({
  queryKey:["automatic-tasks-stock",task.companyId],
  queryFn:()=>api<{items:{id:number;code:string;name:string;sales:number;intervalDays:number}[]}>(
   `/companies/${task.companyId}/tasks/stock_count/items`),
  enabled:expanded&&candidatesOpen&&task.key==="stock_count"&&task.canExecute,
 });
 const select=(field:"assignedEmployeeIds"|"followerEmployeeIds",employeeId:number,checked:boolean)=>{
  setDraft(current=>({...current,[field]:checked?[...current[field],employeeId]:current[field].filter(id=>id!==employeeId)}));
 };
 const save=async()=>{
  setBusy(true);setError("");setSuccess("");
  try{
   await api(`/companies/${task.companyId}/tasks/${task.key}`,{method:"PUT",body:draft});
   setSuccess("تم حفظ كنترول المهمة");setSettingsOpen(false);onSaved();
  }catch(e){setError(e instanceof Error?e.message:"تعذر حفظ إعدادات المهمة")}
  finally{setBusy(false)}
 };
 return <Card>
  <div className="form-actions" style={{justifyContent:"space-between",alignItems:"center",flexWrap:"wrap"}}>
   <div>
    <strong>{task.name}</strong> {task.visible?"":"— غير مطلوبة حاليًا"}
    {task.companyName&&<p>{task.companyName}</p>}
    <p>{task.description}</p>
    <p>{task.key==="memo_required"?
      `المذكرات المطلوب إنجازها: ${number(task.required)}`:
      `أُنجز: ${number(task.completed)} من ${number(task.targetCount)} — المتبقي: ${number(task.required)}`}
    {task.key==="stock_count"&&` — أصناف مطلوب جردها: ${number(task.available)}`}</p>
   </div>
   <div className="form-actions">
    <Button variant="secondary" size="compact" onClick={()=>setExpanded(v=>!v)}>{expanded?"إخفاء":"فتح المهمة"}</Button>
   </div>
  </div>
  {expanded&&<div>
   <div className="form-actions">
    {task.canExecute&&<Link className="button button-primary" to={task.href}>انتقال إلى صفحة التنفيذ</Link>}
    {task.key==="stock_count"&&task.canExecute&&
     <Button variant="secondary" onClick={()=>setCandidatesOpen(v=>!v)}>أصناف مطلوب جردها</Button>}
    {task.canControl&&<Button variant="secondary" onClick={()=>{setDraft(draftOf(task));setSettingsOpen(v=>!v);setError("");setSuccess("");}}>
     {settingsOpen?"إغلاق الكنترول":"كنترول المهمة والصلاحيات"}</Button>}
   </div>
   {candidatesOpen&&task.key==="stock_count"&&<section>
    {candidates.isLoading&&<p>جارٍ تحميل الأصناف…</p>}
    {candidates.error&&<Notice tone="error">{(candidates.error as Error).message}</Notice>}
    {candidates.data?.items.length===0&&<p>لا توجد أصناف مستحقة للجرد حاليًا.</p>}
    {candidates.data?.items.map(item=><p key={item.id}>
     <Link to={`/companies/${task.companyId}/items/${item.id}`}>{item.code} — {item.name}</Link>
     {" · "}مرات البيع: {number(item.sales)} · فاصل الجرد: {number(item.intervalDays)} يوم
    </p>)}
    {candidates.data?.items.length===50&&<p>تظهر أول 50 صنفًا؛ يمكن متابعة بقية الأصناف بعد الجرد.</p>}
   </section>}
   {success&&<Notice>{success}</Notice>}
   {settingsOpen&&task.canControl&&<section>
    <h3>إعدادات {task.name}</h3>
    <label className="form-field"><input type="checkbox" checked={draft.enabled}
      onChange={e=>setDraft({...draft,enabled:e.target.checked})}/> تفعيل المهمة</label>
    {task.key!=="memo_required"&&<div className="form-actions">
     <label>العدد المطلوب
      <input type="number" min={1} max={1000} value={draft.targetCount}
       onChange={e=>setDraft({...draft,targetCount:Number(e.target.value)})}/></label>
     <label>فترة التقييم بالأيام
      <input type="number" min={1} max={365} value={draft.periodDays}
       onChange={e=>setDraft({...draft,periodDays:Number(e.target.value)})}/></label>
    </div>}
    <p>صلاحيات التكليف: عند عدم اختيار موظف، تُعرض المهمة تلقائيًا لكل موظف يملك صلاحية صفحة التنفيذ.</p>
    <div className="form-actions" style={{flexWrap:"wrap"}}>
     {employees.map(employee=><label key={employee.id}>
      <input type="checkbox" checked={draft.assignedEmployeeIds.includes(employee.id)}
       onChange={e=>select("assignedEmployeeIds",employee.id,e.target.checked)}/> {employee.name}
     </label>)}
    </div>
    <p>صلاحيات المتابعة: الموظفون المختارون يستطيعون متابعة ظهور المهمة، دون تجاوز صلاحيات المستندات الأصلية.</p>
    <div className="form-actions" style={{flexWrap:"wrap"}}>
     {employees.map(employee=><label key={employee.id}>
      <input type="checkbox" checked={draft.followerEmployeeIds.includes(employee.id)}
       onChange={e=>select("followerEmployeeIds",employee.id,e.target.checked)}/> {employee.name}
     </label>)}
    </div>
    {error&&<Notice tone="error">{error}</Notice>}
    <div className="form-actions"><Button disabled={busy} onClick={()=>void save()}>{busy?"جارٍ الحفظ…":"حفظ كنترول المهمة"}</Button></div>
   </section>}
  </div>}
 </Card>;
}
export function AutomaticTasksPage({context}:{context?:CompanyContext}) {
 const {user}=useSession();const client=useQueryClient();
 const companyId=context?.company.id;
 const [search,setSearch]=useState("");
 const [all,setAll]=useState(false);
 const list=useQuery({
  queryKey:["automatic-tasks",user?.id,companyId??null,all],
  queryFn:()=>api<{items:Task[]}>(companyId?
   `/companies/${companyId}/tasks${all&&context?.general?"?all=true":""}`:"/tasks"),
  enabled:!!user,refetchOnWindowFocus:true,staleTime:0,
 });
 const members=useQuery({
  queryKey:["task-employees",user?.id,companyId],
  queryFn:()=>api<{items:Employee[]}>(`/companies/${companyId}/employees?pageSize=100`),
  enabled:!!user&&!!companyId&&!!context?.general,
 });
 const tasks=useMemo(()=>(list.data?.items??[]).filter(task=>
  !search||[task.name,task.description,task.companyName??""].join(" ").toLocaleLowerCase("ar")
   .includes(search.trim().toLocaleLowerCase("ar"))),[list.data,search]);
 return <>
  <PageHeader title="المهام الآلية" description="تظهر المهام من سجلات العمل تلقائيًا؛ لا تُضاف مهام يدويًا."/>
  <Card>
   <div className="form-actions" style={{flexWrap:"wrap"}}>
    <label>بحث في المهام <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="اسم المهمة أو الشركة"/></label>
    {context?.general&&<label><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/> عرض جميع التعريفات حتى غير المطلوبة</label>}
    <Button variant="secondary" size="compact" onClick={()=>void client.invalidateQueries({queryKey:["automatic-tasks"]})}>تحديث</Button>
   </div>
  </Card>
  {list.isLoading&&<Notice>جارٍ تحميل المهام…</Notice>}
  {list.error&&<Notice tone="error">{(list.error as Error).message}</Notice>}
  {!list.isLoading&&!list.error&&!tasks.length&&<Notice>لا توجد مهام مطلوبة حاليًا.</Notice>}
  {tasks.map(task=><TaskRow key={`${task.companyId}:${task.key}`} task={task}
   employees={members.data?.items.filter(e=>e.active)??[]}
   onSaved={()=>void client.invalidateQueries({queryKey:["automatic-tasks"]})}/>)}
 </>;
}
