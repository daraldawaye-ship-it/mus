import {useState} from "react";
import {Link,useSearchParams} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import type {CompanyContext,MemoReportResult,MemoRecipient} from "../../../../packages/contracts/src/index";
import {memoTypeLabels} from "../../../../packages/contracts/src/index";
import {api,useSession} from "../api";
import {usePageDirectory} from "../page-directory";
import {errorMessage} from "../phase2";
import {Button,Card,Field,Notice,PageHeader,Select} from "../ui";
import {rememberRecentEntity} from "../recent-entities";
const fmtDate=(value:string|null)=>value?new Intl.DateTimeFormat("ar-YE",{
 timeZone:"Asia/Aden",dateStyle:"short",timeStyle:"short"}).format(new Date(value)):"—";
const hours=(n:number)=>n<1?`${Math.round(n*60)} دقيقة`:
 n<24?`${n.toFixed(1)} ساعة`:`${(n/24).toFixed(1)} يوم`;
export function MemoReportPage({context}:{context:CompanyContext}){
 const companyId=context.company.id,{user}=useSession(),[params,setParams]=useSearchParams();
 const directory=usePageDirectory(companyId);
 const get=(key:string)=>params.get(key)??"";
 const page=Math.max(1,Number(get("page"))||1);
 const [lookup,setLookup]=useState("");
 function change(key:string,value:string){setParams(prev=>{
  const next=new URLSearchParams(prev);
  if(value)next.set(key,value);else next.delete(key);
  if(key!=="page")next.delete("page");
  return next;
 });}
 const entries=directory.data??[];
 const canView=entries.some(e=>e.key==="company.memo-report"&&e.actionAccess.view);
 const filters=new URLSearchParams(params);
 const report=useQuery({
  queryKey:["memo-report",user?.id,companyId,params.toString()],
  queryFn:({signal})=>api<MemoReportResult>(
    `/companies/${companyId}/memos/report?${filters.toString()}`,{signal}),
  enabled:!!user&&canView,
 });
 const staff=useQuery({
  queryKey:["memo-report-employees",user?.id,companyId,lookup],
  queryFn:({signal})=>api<{items:MemoRecipient[]}>(`/companies/${companyId}/memos/recipients?q=${encodeURIComponent(lookup)}&pageSize=100`,{signal}),
  enabled:!!user&&canView,
 });
 const metric=report.data?.metrics;
 return <div className="wallet-page">
  <PageHeader title="تقرير المذكرات" description="متابعة الموظفين والتكليفات والمدة الفعلية بتوقيت اليمن"
   actions={<><Link className="button button-secondary" to={`/companies/${companyId}/memos`}>المذكرات</Link>
    <Button variant="secondary" onClick={()=>void report.refetch()}>تحديث</Button></>}/>
  {!canView&&<Notice tone="warning">صفحة التقرير غير متاحة لصلاحياتك الحالية.</Notice>}
  {report.error&&<Notice tone="error">{errorMessage(report.error)}</Notice>}
  <Card title="التصفية">
   <div className="form-grid">
    <Select label="الحالة" value={get("status")} onChange={e=>change("status",e.target.value)}>
     <option value="">كل الحالات</option><option value="pending">معلقة</option>
     <option value="awaiting_approval">بانتظار الاعتماد</option>
     <option value="completed">منجزة</option>
    </Select>
    <Select label="نوع المذكرة" value={get("type")} onChange={e=>change("type",e.target.value)}>
     <option value="">كل الأنواع</option>{Object.entries(memoTypeLabels).map(([key,label])=>
      <option key={key} value={key}>{label}</option>)}
    </Select>
    <Select label="التأجيل" value={get("deferred")} onChange={e=>change("deferred",e.target.value)}>
     <option value="">الكل</option><option value="yes">المؤجلة</option><option value="no">غير المؤجلة</option>
    </Select>
    <Select label="صفة الموظف" value={get("employeeRole")||"current"}
     onChange={e=>change("employeeRole",e.target.value)}>
     <option value="current">المسؤول الحالي</option><option value="sender">المرسل</option>
     <option value="executor">المنفذ في أي مرحلة</option>
    </Select>
    <Field label="بحث موظف" value={lookup} onChange={e=>setLookup(e.target.value)}/>
    <Select label="الموظف المحدد" value={get("employeeId")} onChange={e=>{
      change("employeeId",e.target.value);
      const selected=staff.data?.items.find(item=>String(item.id)===e.target.value);
      if(user&&selected)rememberRecentEntity(user.id,companyId,"employee",
        {id:selected.id,name:selected.name});
    }}>
     <option value="">جميع الموظفين</option>
     {staff.data?.items.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
    </Select>
    <Select label="مرجع الفترة" value={get("dateField")||"created"}
     onChange={e=>change("dateField",e.target.value)}>
     <option value="created">الإنشاء</option><option value="assigned">الإسناد الحالي</option>
     <option value="completed">الإنجاز</option>
    </Select>
    <Field label="من تاريخ" type="date" value={get("from")} onChange={e=>change("from",e.target.value)}/>
    <Field label="إلى تاريخ" type="date" value={get("to")} onChange={e=>change("to",e.target.value)}/>
    <Field label="الحد الأدنى لمدة الإسناد (ساعة)" type="number"
     value={get("minHours")} onChange={e=>change("minHours",e.target.value)}/>
    <Select label="صفحة مرتبطة" value={get("pageKey")} onChange={e=>change("pageKey",e.target.value)}>
     <option value="">جميع الصفحات</option>
     {entries.filter(e=>e.key.startsWith("company.")&&e.actionAccess.view).map(e=>
      <option key={e.key} value={e.key}>{e.name}</option>)}
    </Select>
    <Field label="رقم الصنف المرتبط" type="number" value={get("itemId")}
     onChange={e=>change("itemId",e.target.value)}/>
    <Field label="رقم الحساب المرتبط" type="number" value={get("accountId")}
     onChange={e=>change("accountId",e.target.value)}/>
   </div>
   <Button variant="secondary" onClick={()=>setParams(new URLSearchParams())}>مسح التصفية</Button>
  </Card>
  <Card title="ملخص المذكرات ضمن نطاق الوصول">
   {metric?<div className="form-grid">
    <p>الإجمالي: <strong>{metric.total.toLocaleString("en-US")}</strong></p>
    <p>معلقة: <strong>{metric.pending.toLocaleString("en-US")}</strong></p>
    <p>بانتظار الاعتماد: <strong>{metric.awaitingApproval.toLocaleString("en-US")}</strong></p>
    <p>منجزة: <strong>{metric.completed.toLocaleString("en-US")}</strong></p>
    <p>مؤجلة: <strong>{metric.deferred.toLocaleString("en-US")}</strong></p>
    <p>متوسط إنجاز الأعمال المنجزة: <strong>{metric.averageCompletedHours===null?"—":hours(metric.averageCompletedHours)}</strong></p>
   </div>:<p className="muted">لا توجد نتائج بعد.</p>}
  </Card>
  <Card title="مؤشرات الموظفين">
   <div className="table-scroll">
    <table><thead><tr>
      <th>الموظف</th><th>مطلوب منه</th><th>بانتظار اعتماده</th>
      <th>مؤجلة لديه</th><th>أنجزها واعتمدت</th><th>طلب اعتمادها</th>
      <th>مرات إعادتها</th><th>أقدم إسناد</th>
      <th>وقت التنفيذ</th><th>وقت الاعتماد</th>
    </tr></thead><tbody>
      {report.data?.employees.map(e=><tr key={e.userId}>
       <td>{e.name}</td><td>{e.required}</td><td>{e.awaitingApproval}</td>
       <td>{e.deferred}</td><td>{e.approvedWork}</td><td>{e.requestedApproval}</td>
       <td>{e.reopened}</td><td>{fmtDate(e.oldestRequiredAt)}</td>
       <td>{hours(e.executionHours)}</td><td>{hours(e.approvalHours)}</td>
      </tr>)}
    </tbody></table>
   </div>
   <p className="muted">المدد بالأوقات الفعلية، ولا تدخل فترة انتظار اعتماد المرسل ضمن وقت التنفيذ.</p>
  </Card>
  <Card title="تفاصيل المذكرات">
   <div className="table-scroll"><table><thead><tr>
    <th>المذكرة</th><th>المرسل</th><th>المسؤول الحالي</th>
    <th>الحالة</th><th>عمر المذكرة</th><th>الإسناد الحالي</th>
    <th>التنفيذ</th><th>الاعتماد</th><th>العودة</th><th>مرات الإعادة</th>
   </tr></thead><tbody>
    {report.data?.items.map(row=><tr key={row.id}>
     <td><Link to={`/companies/${companyId}/memos/${row.id}`}>{row.title}</Link></td>
     <td>{row.senderName}</td><td>{row.currentName}</td><td>{
      row.status==="pending"?"معلقة":row.status==="awaiting_approval"?"بانتظار الاعتماد":"منجزة"
     }</td>
     <td>{hours(row.ageHours)}</td><td>{hours(row.assignmentHours)}</td>
     <td>{hours(row.executionHours)}</td><td>{hours(row.approvalHours)}</td>
     <td>{row.deferred?fmtDate(row.dueAt):"—"}</td><td>{row.returnCount}</td>
    </tr>)}
   </tbody></table></div>
   {report.data?.items.map(row=>row.assignmentPeriods.length>0&&
    <details key={row.id}><summary>توزيع مدة المذكرة: {row.title}</summary>
     {row.assignmentPeriods.map((period,i)=><p key={i} className="muted">
      {period.name}: {hours(period.hours)} ({period.role==="approval"?"انتظار الاعتماد":"تنفيذ"})
     </p>)}
    </details>)}
   <div className="memo-action-buttons">
    <Button variant="secondary" disabled={page<=1} onClick={()=>change("page",String(page-1))}>السابق</Button>
    <span>صفحة {page} — {report.data?.total??0} نتيجة</span>
    <Button variant="secondary" disabled={page*20 >= (report.data?.total??0)}
     onClick={()=>change("page",String(page+1))}>التالي</Button>
   </div>
  </Card>
 </div>;
}
