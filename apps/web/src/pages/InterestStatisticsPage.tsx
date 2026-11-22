import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";

type ActionCount = {action:string;total:string;visitors:number};
type UserCount = {subject_key:string;name:string;total:string};
type CardCount = {target_type:string;target_id:number;label:string;total:string;visitors:number};
type SearchCount = {term:string;total:string;visitors:number};
type Report = {days:number;retentionDays:number;firstEventsRetained:number;
 actions:ActionCount[];users:UserCount[];cards:CardCount[];searches:SearchCount[]};
type ActivityCursor={at:string;id:string};
type ActivityRow={id:string;occurredAt:string;actorName:string|null;anonymous:boolean;
 employeeName:string|null;employeeId:string|null;actionLabel:string;pathname:string;
 eventDetail:string|null;source:"operator"|"general"};
type ActivityPage={items:ActivityRow[];nextCursor:ActivityCursor|null};
type ActivityFilters={employee:string;user:string;event:string;from:string;to:string};
const emptyActivityFilters:ActivityFilters={employee:"",user:"",event:"",from:"",to:""};
const formats: Record<string,string>={page_view:"فتح صفحة",click:"نقر",card_open:"فتح كرت",search:"بحث"};
const number=(n:number|string)=>new Intl.NumberFormat("ar-YE").format(Number(n)||0);
const cell={border:"1px solid var(--border-color, #8b98a7)",padding:"5px 8px",textAlign:"start" as const};
const formatDate=(s:string)=>new Date(s).toLocaleString("ar-YE",{timeZone:"Asia/Aden"});
const actorLabel=(key:string,name:string)=>key.startsWith("v:")?`زائر غير مسجل (${key.slice(-6)})`:name;
const marketLink=(card:CardCount)=>card.target_type.startsWith("market:")?
  "/medicine-market?card="+card.target_id:null;

function SectionTable({headers,rows}:{headers:string[];rows:React.ReactNode[][]}){
 const [expanded,setExpanded]=useState(false);
 const limit=30;
 const visibleRows=expanded?rows:rows.slice(0,limit);
 return <>
  <div style={{overflowX:"auto"}}>
   <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
    <thead><tr>{headers.map((h,i)=><th key={i} scope="col" style={cell}>{h}</th>)}</tr></thead>
    <tbody>{visibleRows.map((row,i)=><tr key={i}>{row.map((x,j)=><td key={j} style={cell}>{x}</td>)}</tr>)}
     {!rows.length&&<tr><td colSpan={headers.length} style={cell}>لا توجد نتائج لهذه الفترة.</td></tr>}</tbody>
   </table>
  </div>
  {rows.length>limit&&<div style={{marginTop:8}}>
   <Button variant="secondary" size="compact" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>
    {expanded?"عرض أقل":"المزيد"}
   </Button>
  </div>}
 </>;
}

function RecordedInterestActivity(){
 const {user}=useSession();
 const queryClient=useQueryClient();
 const [draft,setDraft]=useState<ActivityFilters>(emptyActivityFilters);
 const [filters,setFilters]=useState<ActivityFilters>(emptyActivityFilters);
 const [cursors,setCursors]=useState<(ActivityCursor|null)[]>([null]);
 const cursor=cursors.at(-1)??null;
 const invalid=!!(draft.from&&draft.to&&draft.from>draft.to);
 const params=new URLSearchParams();
 Object.entries(filters).forEach(([key,value])=>{if(value)params.set(key,value);});
 if(cursor){params.set("cursorAt",cursor.at);params.set("cursorId",cursor.id);}
 const activity=useQuery({queryKey:["interest-events-activity",user?.id,params.toString()],
  queryFn:({signal})=>api<ActivityPage>("/interest-events/activity?"+params,{signal}),
  enabled:!!user?.owner,refetchOnWindowFocus:false,staleTime:15000,retry:false});
 const update=(key:keyof ActivityFilters,value:string)=>setDraft(old=>({...old,[key]:value}));
 const next=activity.data?.nextCursor;
 const refresh=()=>{
  if(cursors.length===1){void activity.refetch();return;}
  // Reset to the newest page; invalidate only this owner activity query family.
  void queryClient.invalidateQueries({queryKey:["interest-events-activity",user?.id],refetchType:"none"});
  setCursors([null]);
 };
 return <Card title="سجل الحركات المسجلة"
  description="يعرض الأحداث العامة وأحداث المشغّل المحتفظ بها، بترتيب الأحدث. التواريخ تشمل يوم النهاية بتوقيت عدن.">
  <form className="table-filters" onSubmit={event=>{
   event.preventDefault();if(invalid)return;
   setCursors([null]);setFilters({employee:draft.employee.trim(),user:draft.user.trim(),
    event:draft.event.trim(),from:draft.from,to:draft.to});
  }}>
   <label className="field">اسم الموظف<input type="search" maxLength={100} value={draft.employee}
    onChange={e=>update("employee",e.currentTarget.value)} /></label>
   <label className="field">اسم حساب المستخدم<input type="search" maxLength={100} value={draft.user}
    onChange={e=>update("user",e.currentTarget.value)} /></label>
   <label className="field">الحدث أو نصه<input type="search" maxLength={120} value={draft.event}
    onChange={e=>update("event",e.currentTarget.value)} /></label>
   <label className="field">من<input type="date" value={draft.from} min="1900-01-01" max="9998-12-31" aria-label="من تاريخ"
    onChange={e=>update("from",e.currentTarget.value)} /></label>
   <label className="field">إلى<input type="date" value={draft.to} min="1900-01-01" max="9998-12-31" aria-label="إلى تاريخ"
    onChange={e=>update("to",e.currentTarget.value)} /></label>
   <Button type="submit" size="compact" disabled={invalid}>تطبيق</Button>
   <Button type="button" size="compact" variant="secondary" disabled={activity.isFetching} onClick={refresh}>تحديث</Button>
   <Button type="button" size="compact" variant="secondary" onClick={()=>{
    setDraft(emptyActivityFilters);setFilters(emptyActivityFilters);setCursors([null]);
   }}>مسح الفلاتر</Button>
  </form>
  <small>إذا لم تُسجَّل هوية الموظف لحظة الحدث، ابحث باسم حساب المستخدم. يظهر اسم الموظف الحالي عند توفره لمعرّف الموظف المسجّل.</small>
  {invalid&&<Notice tone="error">تاريخ البداية يجب ألا يكون بعد النهاية.</Notice>}
  {activity.isPending&&<Notice>جارٍ تحميل سجل الحركات…</Notice>}
  {activity.isError&&<Notice tone="error">تعذر تحميل سجل الحركات: {(activity.error as Error).message}</Notice>}
  {!activity.isError&&activity.data&&<div style={{overflowX:"auto"}}>
   <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}} aria-label="سجل الحركات المسجلة">
    <thead><tr>{["الوقت","النوع","الموظف","المستخدم أو الزائر","الحدث","الهدف أو البحث","الصفحة"].map(h=>
     <th key={h} scope="col" style={cell}>{h}</th>)}</tr></thead>
    <tbody>{activity.data.items.map(row=><tr key={row.id}>
     <td style={cell}>{formatDate(row.occurredAt)}</td>
     <td style={cell}>{row.source==="operator"?"المشغّل":"عام"}</td>
     <td style={cell}>{row.employeeName??(row.employeeId?"موظف #"+row.employeeId:"—")}</td>
     <td style={cell}>{row.actorName??(row.anonymous?"زائر غير مسجل":"مستخدم مسجل")}</td>
     <td style={cell}>{row.actionLabel}</td><td style={cell}>{row.eventDetail??"—"}</td>
     <td style={cell}>{row.pathname||"—"}</td>
    </tr>)}{!activity.data.items.length&&<tr><td colSpan={7} style={cell}>لا توجد أحداث مطابقة.</td></tr>}</tbody>
   </table>
  </div>}
  <div className="form-actions">
   <Button type="button" size="compact" variant="secondary" disabled={cursors.length===1||activity.isFetching}
    onClick={()=>setCursors(old=>old.slice(0,-1))}>السابق</Button>
   <span>الصفحة {number(cursors.length)}</span>
   <Button type="button" size="compact" variant="secondary" disabled={!next||activity.isFetching||activity.isError}
    onClick={()=>{if(next)setCursors(old=>[...old,next]);}}>التالي</Button>
  </div>
 </Card>;
}

export function InterestStatisticsPage(){
 const [days,setDays]=useState(30);
 const report=useQuery({queryKey:["interest-events-report",days],
  queryFn:({signal})=>api<Report>("/interest-events/report?days="+days,{signal}),
  refetchOnWindowFocus:false,staleTime:30000});
 const data=report.data;
 const total=data?.actions.reduce((sum,a)=>sum+Number(a.total),0)??0;
 return <section dir="rtl">
  <PageHeader title="إحصاءات اهتمامات الزوار والمستخدمين"
   description="النقرات وفتح الصفحات والكروت وعمليات البحث. للمالك فقط؛ سجل تحليلي منفصل عن تدقيق المحاسبة والتعديلات."
   actions={<Link to="/medicine-market">السوق الرئيسي</Link>}/>
  <Card>
   <div className="page-actions" style={{display:"flex",flexWrap:"wrap",gap:12,alignItems:"center"}}>
    <label>الفترة <select value={days} onChange={e=>setDays(Number(e.target.value))}>
     <option value={7}>آخر 7 أيام</option><option value={30}>آخر 30 يومًا</option>
     <option value={100}>آخر 100 يوم</option><option value={0}>جميع الفترات (الإجماليات)</option>
    </select></label>
    <Button variant="secondary" size="compact" disabled={report.isFetching}
     onClick={()=>void report.refetch()}>تحديث</Button>
    <strong>عدد التفاعلات: {number(total)}</strong>
    {data&&<span>السجلات الأولى المحفوظة: {number(data.firstEventsRetained)}</span>}
   </div>
   {report.isError&&<Notice tone="error">تعذر قراءة التقرير: {(report.error as Error).message}</Notice>}
   {report.isPending&&<Notice>جارٍ تحميل إحصاءات الاهتمامات…</Notice>}
  </Card>
  {data&&<>
   <Card title="الحركات حسب نوع الحدث">
    <SectionTable key={days} headers={["الحدث","إجمالي المرات","المستخدمون والزوار"]} rows={data.actions.map(a=>
     [formats[a.action]??a.action,number(a.total),number(a.visitors)])} />
   </Card>
   <Card title="أكثر الكروت فتحًا" description="يعرض معرف الكرت الحقيقي؛ النقر على كرت السوق يفتحه.">
    <SectionTable key={days} headers={["الكرت","نوع الكرت","مرات الفتح","عدد الأشخاص"]} rows={data.cards.map(c=>
     [marketLink(c)?<Link to={marketLink(c)!}>{c.label||"كرت #"+c.target_id}</Link>:
       c.label||"كرت #"+c.target_id,
      c.target_type,number(c.total),number(c.visitors)])} />
   </Card>
   <Card title="كلمات وحروف البحث المتكررة" description="تُحسب الكلمة عند التوقف عن الكتابة لحظة قصيرة، لا عند كل ضغطة مفتاح.">
    <SectionTable key={days} headers={["ما جرى البحث عنه","مرات البحث","الأشخاص"]} rows={data.searches.map(s=>
     [s.term,number(s.total),number(s.visitors)])} />
   </Card>
   <Card title="نشاط كل مستخدم أو زائر" description="تتضمن الزيارات المجهولة دون معرفة هوية صاحب الجهاز.">
    <SectionTable key={days} headers={["المستخدم / الزائر","عدد التفاعلات"]} rows={data.users.map(u=>
      [actorLabel(u.subject_key,u.name),number(u.total)])} />
   </Card>
   <p style={{fontSize:12,opacity:.8}}>
    تُحذف التفاصيل الأقدم من {data.retentionDays} يومًا على دفعات،
    بعد حفظ الإجماليات الدائمة وأول سجل لكل حدث ومستخدم وهدف.
    الإحصاءات التاريخية لجميع الفترات لا تتضمن التواريخ اليومية للأحداث المحذوفة.
    لا تُجمع كلمات المرور أو محتويات النماذج أو حركات المؤشر.
   </p>
  </>}
  <RecordedInterestActivity />
 </section>;
}
