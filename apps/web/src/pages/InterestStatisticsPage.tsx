import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";

type ActionCount = {action:string;total:string;visitors:number};
type UserCount = {subject_key:string;name:string;total:string};
type CardCount = {target_type:string;target_id:number;label:string;total:string;visitors:number};
type SearchCount = {term:string;total:string;visitors:number};
type RecentEvent = {occurred_at:string;action:string;target_type:string;target_id:number;
  pathname:string;label:string;dimension_text:string;subject_key:string;name:string};
type Report = {days:number;retentionDays:number;firstEventsRetained:number;
 actions:ActionCount[];users:UserCount[];cards:CardCount[];searches:SearchCount[];recent:RecentEvent[]};
const formats: Record<string,string>={page_view:"فتح صفحة",click:"نقر",card_open:"فتح كرت",search:"بحث"};
const number=(n:number|string)=>new Intl.NumberFormat("ar-YE").format(Number(n)||0);
const cell={border:"1px solid var(--border-color, #8b98a7)",padding:"5px 8px",textAlign:"start" as const};
const formatDate=(s:string)=>new Date(s).toLocaleString("ar-YE",{timeZone:"Asia/Aden"});
const actorLabel=(key:string,name:string)=>key.startsWith("v:")?`زائر غير مسجل (${key.slice(-6)})`:name;
const marketLink=(card:CardCount)=>card.target_type.startsWith("market:")?
  "/medicine-market?card="+card.target_id:
  card.target_type.startsWith("company-item:")?
    "/companies/"+card.target_type.split(":")[1]+"/items/"+card.target_id:null;

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
   <Card title="أحدث 100 حركة مسجلة">
    <SectionTable key={days} headers={["الوقت","المستخدم أو الزائر","الحدث","الهدف أو البحث","الصفحة"]} rows={data.recent.map(e=>
      [formatDate(e.occurred_at),actorLabel(e.subject_key,e.name),formats[e.action]??e.action,
       e.action==="search"?e.dimension_text:e.label||e.target_type+(e.target_id?" #"+e.target_id:""),
       e.pathname])} />
   </Card>
   <p style={{fontSize:12,opacity:.8}}>
    تُحذف التفاصيل الأقدم من {data.retentionDays} يومًا على دفعات،
    بعد حفظ الإجماليات الدائمة وأول سجل لكل حدث ومستخدم وهدف.
    الإحصاءات التاريخية لجميع الفترات لا تتضمن التواريخ اليومية للأحداث المحذوفة.
    لا تُجمع كلمات المرور أو محتويات النماذج أو حركات المؤشر.
   </p>
  </>}
 </section>;
}
