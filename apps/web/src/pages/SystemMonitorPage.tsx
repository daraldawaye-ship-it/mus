import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";

type TableStat = {
 schema:string;name:string;estimatedRows:number;deadRows:number;dataBytes:number;
 indexBytes:number;totalBytes:number;lastVacuum:string|null;lastAnalyze:string|null;
};
type DatabaseStats = {
 name:string; database:string;schema:string;measuredAt:string;capacityBytes:number|null;
 databaseBytes:number;remainingBytes:number|null;
 summary:{tableCount:number;estimatedRows:number;deadRows:number;indexBytes:number;connections:number;
 activeConnections:number;transactionsCommitted:number;transactionsRolledBack:number;
 deadlocks:number;cacheHits:number;blocksRead:number;postgresVersion:string};
 tables:TableStat[];
};
type RuntimeStats = {updatedAt:string;buildSizeBytes:number;buildFileCount:number;
 processMemoryBytes:number;processHeapBytes:number;processUptimeSeconds:number;
 ephemeralFileSystemBytes:number|null;ephemeralFreeBytes:number|null;storageNote:string;serviceUrl:string};
type Metric = {value:number;unit:string;timestamp:string}|null;
type RenderStats = {apiConnected:boolean;updatedAt:string;bandwidthGB:number|null;memory:Metric;
 cpu:Metric;note:string;billingUrl:string;scope?:string};
const number = (v:number)=>new Intl.NumberFormat("ar-YE",{maximumFractionDigits:2}).format(v);
const bytes = (n:number|null|undefined)=>{
 if(n===null || n===undefined || !Number.isFinite(n)) return "غير متاح";
 if(n<1024) return number(n)+" B";
 const units=["KB","MB","GB","TB"];let x=n;let i=-1;
 do {x/=1024;i++;} while(x>=1024 && i<3);
 return number(x)+" "+units[i];
};
const since=(d:string|null)=>d?new Date(d).toLocaleString("ar-YE"):"—";
const bar=(used:number,capacity:number|null)=>capacity&&capacity>0?
 <div style={{height:9,background:"var(--border-color, #d7dce3)",borderRadius:8,overflow:"hidden",marginTop:8}}>
   <div style={{height:"100%",width:Math.min(100,100*used/capacity)+"%",background:used/capacity>.85?"#da8034":"#278cbd"}}/>
 </div>:null;
const MetricCard=({title,value,detail}:{title:string;value:string;detail?:string})=>
 <div style={{border:"1px solid var(--border-color, #d9dce1)",borderRadius:12,padding:14,minWidth:150,flex:"1 1 180px"}}>
  <div style={{opacity:.78,fontSize:13,marginBottom:8}}>{title}</div>
  <strong style={{fontSize:22,overflowWrap:"anywhere"}}>{value}</strong>
  {detail&&<div style={{opacity:.75,fontSize:12,marginTop:6}}>{detail}</div>}
 </div>;
export function SystemMonitorPage(){
 const [selected,setSelected]=useState<"main"|"market">("main");
 const [search,setSearch]=useState("");
 const [sort,setSort]=useState<"size"|"rows"|"name">("size");
 const [counts,setCounts]=useState<Record<string,number>>({});
 const [checking,setChecking]=useState<string|null>(null);
 const [countError,setCountError]=useState("");
 const endpoint=selected==="main"?"/system-monitor/main":"/medicine-market/admin/monitor";
 const db=useQuery({queryKey:["system-monitor-db",selected],
  queryFn:()=>api<DatabaseStats>(endpoint),staleTime:60000,refetchOnWindowFocus:false,retry:1});
 const runtime=useQuery({queryKey:["system-monitor-runtime"],
  queryFn:()=>api<RuntimeStats>("/system-monitor/runtime"),staleTime:60000,retry:1});
 const render=useQuery({queryKey:["system-monitor-render"],
  queryFn:()=>api<RenderStats>("/system-monitor/render"),staleTime:60000,retry:1});
 const rows=useMemo(()=>{
  const needle=search.trim().toLocaleLowerCase();
  const items=(db.data?.tables??[]).filter(r=>(r.schema+"."+r.name).toLocaleLowerCase().includes(needle));
  return items.sort((a,b)=>sort==="rows"?(b.estimatedRows-a.estimatedRows):sort==="name"?
   (a.schema+"."+a.name).localeCompare(b.schema+"."+b.name):(b.totalBytes-a.totalBytes));
 },[db.data,search,sort]);
 const countExact=async(row:TableStat)=>{
  const key=selected+":"+row.schema+"."+row.name;
  setChecking(key);setCountError("");
  const query="?schema="+encodeURIComponent(row.schema)+"&table="+encodeURIComponent(row.name);
  try {const result=await api<{count:number}>(endpoint+"/count"+query);
   setCounts(s=>({...s,[key]:result.count}));}
  catch(e){setCountError(e instanceof Error?e.message:"تعذر حساب العدد الدقيق");}
  finally{setChecking(null);}
 };
 const data=db.data, rt=runtime.data, re=render.data;
 const snapshot=[
  ["النطاق الترددي المشمول","4.2 / 5 GB","84%"],
  ["دقائق Pipeline","87 / 500","17.4%"],
  ["خدمات Render","4 / 25","16%"],
  ["النطاقات المخصصة","0 / 2","0%"],
  ["ساعات الخدمات المجانية","0 / 750","0%"]
 ];
 return <main>
  <PageHeader title="مراقبة النظام وقواعد البيانات"
   description="إحصاءات للعرض فقط — قياسات PostgreSQL والتخزين، وحالة التطبيق وRender. لا تُعدّل بيانات الموقع." 
   actions={<Button variant="secondary" onClick={()=>void Promise.all([db.refetch(),runtime.refetch(),render.refetch()])}>تحديث الإحصاءات</Button>}/>
  <Card title="اختيار قاعدة البيانات" description="اختر القاعدة أولًا؛ السوق منفصل عن قاعدة الشركات والمبيعات">
   <div className="form-actions" style={{flexWrap:"wrap",alignItems:"center"}}>
    <label className="form-field" style={{minWidth:280}}>قاعدة البيانات
     <select value={selected} onChange={e=>{setSelected(e.target.value as "main"|"market");setCountError("");}}>
      <option value="main">الرئيسي — قاعدة بيانات الصيدلية والنظام</option>
      <option value="market">سوق الأدوية — قاعدة مستقلة</option>
     </select>
    </label>
    <span style={{opacity:.8}}>الأعداد تقديرية من PostgreSQL، ويُحسب العدد الدقيق عند الطلب فقط.</span>
   </div>
  </Card>
  {db.isLoading&&<p>جارٍ قراءة جداول قاعدة البيانات…</p>}
  {db.error&&<Notice tone="error">تعذرت قراءة قاعدة {selected==="main"?"الرئيسي":"السوق"}: {(db.error as Error).message}. لا يلزم فتح اتصالات PostgreSQL خارجية.</Notice>}
  {data&&<>
   <Card title={"حالة قاعدة بيانات "+data.name} description={"اسم القاعدة: "+data.database+" · آخر قياس: "+since(data.measuredAt)}>
    <div style={{display:"flex",flexWrap:"wrap",gap:10}}>
     <MetricCard title="حجم قاعدة البيانات" value={bytes(data.databaseBytes)} />
     <MetricCard title="السعة المخصصة في Render" value={bytes(data.capacityBytes)} detail="السعة المسجلة عند إعداد المراقبة؛ راجع Render عند ترقية القرص"/>
     <MetricCard title="المتبقي التقريبي" value={bytes(data.remainingBytes)} />
     <MetricCard title="عدد الجداول" value={number(data.summary.tableCount)}/>
     <MetricCard title="إجمالي الصفوف التقريبي" value={number(data.summary.estimatedRows)}/>
     <MetricCard title="حجم الفهارس" value={bytes(data.summary.indexBytes)}/>
     <MetricCard title="الاتصالات الحالية" value={number(data.summary.connections)}/>
     <MetricCard title="صفوف ميتة" value={number(data.summary.deadRows)}/>
    </div>
    {bar(data.databaseBytes,data.capacityBytes)}
    <p style={{fontSize:13,opacity:.75}}>الحجم المحسوب هو PG_DATABASE_SIZE ويشمل البيانات والفهارس والأجزاء الداخلية. السعة المخصصة لا تساوي إجمالي الصفوف، والمقدار المتبقي تقريب مبني على حصة القرص.</p>
    <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
     <MetricCard title="المعاملات الناجحة" value={number(data.summary.transactionsCommitted)}/>
     <MetricCard title="المعاملات المتراجعة" value={number(data.summary.transactionsRolledBack)}/>
     <MetricCard title="تعطل الأقفال" value={number(data.summary.deadlocks)}/>
     <MetricCard title="قراءات من الذاكرة المؤقتة" value={number(data.summary.cacheHits)}/>
     <MetricCard title="قراءات من القرص" value={number(data.summary.blocksRead)}/>
     <MetricCard title="إصدار PostgreSQL" value={data.summary.postgresVersion}/>
    </div>
   </Card>
   <Card title="جميع جداول قاعدة البيانات" description="أحجام الجدول تشمل بياناته وفهارسه؛ الترتيب الافتراضي من الأكبر إلى الأصغر">
    <div className="form-actions" style={{flexWrap:"wrap",gap:10,alignItems:"center"}}>
     <label className="form-field">بحث باسم الجدول
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="اسم الجدول أو المخطط" />
     </label>
     <label className="form-field">ترتيب
      <select value={sort} onChange={e=>setSort(e.target.value as typeof sort)}>
       <option value="size">الحجم — الأكبر</option><option value="rows">الصفوف — الأكثر</option><option value="name">الاسم</option>
      </select>
     </label>
     <span>{number(rows.length)} جدول</span>
    </div>
    {countError&&<Notice tone="error">{countError}</Notice>}
    <div style={{overflowX:"auto",maxHeight:"68vh",overflowY:"auto",marginTop:10}}>
     <table className="data-table" style={{width:"100%",minWidth:850}}>
      <thead><tr><th>المخطط</th><th>اسم الجدول</th><th>عدد الصفوف</th><th>حجم البيانات</th><th>حجم الفهارس</th><th>الحجم الكلي</th><th>المحذوفة تقديريًا</th></tr></thead>
      <tbody>{rows.map(t=>{
       const key=selected+":"+t.schema+"."+t.name;
       return <tr key={key}>
        <td>{t.schema}</td><td dir="ltr" style={{textAlign:"start",fontFamily:"monospace"}}>{t.name}</td>
        <td><div>{number(counts[key]??t.estimatedRows)} {counts[key]===undefined&&<small title="تقديري">(تقريبي)</small>}</div>
         {counts[key]===undefined&&<Button size="compact" variant="secondary" disabled={checking!==null} onClick={()=>void countExact(t)}>{checking===key?"جارٍ الحساب":"العدد الدقيق"}</Button>}
        </td>
        <td>{bytes(t.dataBytes)}</td><td>{bytes(t.indexBytes)}</td><td><strong>{bytes(t.totalBytes)}</strong></td>
        <td>{number(t.deadRows)}</td>
       </tr>;
      })}</tbody>
     </table>
    </div>
   </Card>
  </>}
  <Card title="حالة الموقع وحجم الملفات" description="ملفات الواجهة المنشورة على الخادم، واستهلاك عملية التطبيق الحالية">
   {runtime.error&&<Notice tone="error">تعذرت قراءة إحصاءات التطبيق.</Notice>}
   {rt&&<div style={{display:"flex",flexWrap:"wrap",gap:10}}>
    <MetricCard title="حجم ملفات الموقع المبنية" value={bytes(rt.buildSizeBytes)}/>
    <MetricCard title="عدد ملفات الواجهة" value={number(rt.buildFileCount)}/>
    <MetricCard title="ذاكرة عملية الموقع" value={bytes(rt.processMemoryBytes)}/>
    <MetricCard title="ذاكرة JavaScript المستعملة" value={bytes(rt.processHeapBytes)}/>
    <MetricCard title="مدة عمل العملية" value={number(Math.floor(rt.processUptimeSeconds/3600))+" ساعة"}/>
    <MetricCard title="المتبقي بنظام ملفات الحاوية" value={bytes(rt.ephemeralFreeBytes)} detail="مؤقت، لا يُعد حصة تخزين ثابتة"/>
   </div>}
   <p style={{fontSize:13,opacity:.75}}>الموقع ليس له بالضرورة «سعة تخزين متبقية» مستقلة؛ ملفات الحاوية مؤقتة، بينما التخزين الدائم للبيانات في PostgreSQL. لا تُخلط مساحة الموقع بذاكرة RAM أو نقل البيانات.</p>
  </Card>
  <Card title="إحصاءات Render والفوترة">
   <p>مراقبة نقل البيانات وذاكرة الخدمة ومعالجها؛ بعض بيانات الفوترة لا تتيحها واجهة القياسات البرمجية.</p>
   {render.error&&<Notice tone="error">تعذرت قراءة تكامل Render.</Notice>}
   {re&&<>
    <div style={{display:"flex",flexWrap:"wrap",gap:10}}>
     <MetricCard title="نقل البيانات هذا الشهر للخدمة الرئيسية" value={re.bandwidthGB===null?"غير متاح":number(re.bandwidthGB)+" GB"} detail="ليس بالضرورة إجمالي حساب Render"/>
     <MetricCard title="استهلاك ذاكرة Render" value={re.memory?bytes(re.memory.value):"غير متاح"}/>
     <MetricCard title="استهلاك المعالج Render" value={re.cpu?number(re.cpu.value)+" CPU":"غير متاح"}/>
     <MetricCard title="اتصال API" value={re.apiConnected?"مُهيأ":"غير مُهيأ"}/>
    </div>
    <p style={{fontSize:13}}>{re.note}</p>
   </>}
   <h3 style={{fontSize:16,marginTop:14}}>آخر قراءة من الصورة — 5 نوفمبر 2026 (ثابتة وليست مباشرة)</h3>
   <div style={{display:"flex",flexWrap:"wrap",gap:10}}>{snapshot.map(([title,value,percent])=><MetricCard key={title} title={title} value={value} detail={percent+" من الحصة"} />)}</div>
   <p style={{fontSize:13,opacity:.75}}>تشمل الشاشة الأصلية أيضًا HTTP Responses: 4.19 GB، وService-Initiated: 5 MB، وWebSocket: صفر تقريبًا. هذه أرقام الصورة فقط وتتغير في حساب Render.</p>
   <a href="https://dashboard.render.com/billing" target="_blank" rel="noreferrer" className="button button-secondary">فتح فوترة Render — القيم الحية</a>
   {" "}
   <a href="https://dashboard.render.com/web/srv-dbdlueo473hc73cqtsb0" target="_blank" rel="noreferrer" className="button button-secondary">مقاييس خدمة الموقع</a>
   {" "}
   <a href="https://dashboard.render.com/d/dpg-dbdltoo473hc73cqrkqg-a" target="_blank" rel="noreferrer" className="button button-secondary">قاعدة الرئيسي</a>
   {" "}
   <a href="https://dashboard.render.com/d/dpg-dbjfh4ou01pc73fasu80-a" target="_blank" rel="noreferrer" className="button button-secondary">قاعدة السوق</a>
  </Card>
 </main>;
}
