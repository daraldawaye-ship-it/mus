import { useMemo,useState } from "react";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Button,Card,Field,Notice,Select } from "../ui";
import { errorMessage } from "../phase2";
type Task={id:number;title:string;body:string;status:string;due_at:string|null;priority:number;reason:string;source:"manual"|"automatic";task_priority:number|null;task_priority_reason:string;cases:{id:number;title:string;next_hearing:string|null}[]};
const labels:Record<string,string>={pending:"مطلوبة",working:"جارٍ العمل",submitted:"تم الإبلاغ",blocked:"متعذرة",verified:"منجزة"};
export function LegalTaskBoard({owner}:{owner:boolean}){
 const [,setParams]=useSearchParams(),cache=useQueryClient(),[search,setSearch]=useState(""),[filter,setFilter]=useState("open");
 const [edit,setEdit]=useState<number|null>(null),[priority,setPriority]=useState("1"),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const query=useQuery({queryKey:["legal","task-board"],queryFn:()=>api<{items:Task[];total:number}>("/legal/tasks")});
 const tasks=useMemo(()=>(query.data?.items??[]).filter(t=>(filter==="all"||(filter==="open"&&t.status!=="verified")||(filter==="done"&&t.status==="verified")||filter===String(t.priority))&&(!search||[t.title,t.body,...t.cases.map(c=>c.title)].join(" ").includes(search))),[query.data,filter,search]);
 const save=async(t:Task)=>{setBusy(true);setError("");try{await api("/legal/tasks/"+t.id+"/priority",{method:"PUT",body:{priority:priority==="auto"?null:Number(priority),reason}});setEdit(null);await cache.invalidateQueries({queryKey:["legal"]});}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
 const openCase=(id:number)=>setParams({case:String(id),tab:"task"});
 return <Card title="جميع المهام — حسب الأولوية">
  <p>الترتيب تلقائي بحسب المواعيد والمحبوسيات والتنفيذ والطعون والمعطيات المسجلة. الرقم 1 هو الأكثر استعجالًا. يمكنك تحديد أولوية يدوية لأي مهمة، أو إعادتها إلى التقييم التلقائي.</p>
  <div className="legal-actions"><Field label="بحث في المهام" value={search} onChange={e=>setSearch(e.target.value)}/><Select label="تصفية" value={filter} onChange={e=>setFilter(e.target.value)}><option value="open">غير المنجزة</option><option value="all">الكل</option><option value="done">المنجزة</option>{Array.from({length:10},(_,i)=><option key={i} value={String(i+1)}>أولوية {i+1}</option>)}</Select></div>
  <p>عدد المعروض: {tasks.length} / {query.data?.total??"…"}</p>
  {query.error&&<Notice tone="error">{errorMessage(query.error)}</Notice>}{error&&<Notice tone="error">{error}</Notice>}
  <div className="legal-task-scroll"><table className="legal-task-table"><thead><tr><th>#</th><th>الأولوية</th><th>المهمة</th><th>القضية</th><th>الموعد</th><th>الحالة</th>{owner&&<th>تعديل</th>}</tr></thead><tbody>{tasks.map((t,i)=><tr key={t.id}><td>{i+1}</td><td><strong>{t.priority}</strong><small>{t.source==="manual"?"يدوي":"تلقائي"}</small><small>{t.reason}</small></td><td><strong>{t.title}</strong><details><summary>التفاصيل</summary><p>{t.body}</p></details></td><td>{t.cases.length?t.cases.map(c=><Button key={c.id} size="compact" variant="secondary" onClick={()=>openCase(c.id)}>{c.title}</Button>):"غير مرتبطة"}</td><td>{t.due_at?new Date(t.due_at).toLocaleDateString("ar-YE",{timeZone:"Asia/Aden"}):"غير محدد"}</td><td>{labels[t.status]??t.status}</td>{owner&&<td>{edit===t.id?<div className="legal-priority-edit"><Select label="الأولوية" value={priority} onChange={e=>setPriority(e.target.value)}><option value="auto">تلقائية</option>{Array.from({length:10},(_,i)=><option key={i} value={String(i+1)}>{i+1}</option>)}</Select><Field label="سبب الأولوية" value={reason} onChange={e=>setReason(e.target.value)}/><Button disabled={busy} onClick={()=>void save(t)}>حفظ</Button><Button variant="secondary" onClick={()=>setEdit(null)}>إلغاء</Button></div>:<Button size="compact" variant="secondary" onClick={()=>{setEdit(t.id);setPriority(String(t.task_priority??t.priority));setReason(t.task_priority_reason??"");}}>الأولوية</Button>}</td>}</tr>)}</tbody></table></div>
 </Card>;
}
