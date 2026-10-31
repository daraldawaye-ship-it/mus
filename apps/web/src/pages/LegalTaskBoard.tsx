import { useMemo, useState, type FormEvent } from "react";
import { MessageSquareText } from "lucide-react";
import "./LegalTaskBoard.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useScopeGuard, useSession } from "../api";
import { Button, Card, Dialog, Field, Notice, Select } from "../ui";
import { errorMessage } from "../phase2";

export type LegalTaskPriority = {
  id: number;
  revision: number;
  task_priority: number | null;
  task_priority_reason: string;
  priority: number;
  reason: string;
  source: "manual" | "automatic";
};
type Task = LegalTaskPriority & {
  title: string;
  body: string;
  status: string;
  due_at: string | null;
  follow_up_required?: boolean;
  original_due_at?: string | null;
  original_next_hearing?: string | null;
  cases: { id: number; title: string; next_hearing: string | null }[];
  comment_count: number;
};
const labels: Record<string, string> = {
  pending: "مطلوبة", working: "جارٍ العمل", submitted: "تم الإبلاغ",
  blocked: "متعذرة", verified: "منجزة",
};

export function LegalTaskPriorityControl({ task }: { task: LegalTaskPriority }) {
  const cache = useQueryClient();
  const guard = useScopeGuard(`legal:task-priority:${task.id}`);
  const [edit, setEdit] = useState(false);
  const [priority, setPriority] = useState("auto");
  const [reason, setReason] = useState("");
  const [revision, setRevision] = useState(task.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/legal/tasks/${task.id}/priority`, {
        method: "PUT",
        body: { priority: priority === "auto" ? null : Number(priority), reason, revision },
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setEdit(false);
      setSaved(true);
      await cache.invalidateQueries({ queryKey: ["legal"] });
    } catch (cause) {
      if (guard.isCurrent()) {
        setError(errorMessage(cause));
        void cache.invalidateQueries({ queryKey: ["legal"] });
      }
    } finally {
      if (guard.isCurrent()) setBusy(false);
    }
  }
  return <div className="legal-priority-control">
    {edit ? <div className="legal-priority-edit">
      <Select label="الأولوية" value={priority} disabled={busy}
        onChange={event => setPriority(event.target.value)}>
        <option value="auto">تلقائية حسب المعطيات</option>
        {Array.from({ length: 10 }, (_, i) => <option key={i} value={String(i + 1)}>
          {i + 1}{i === 0 ? " — الأكثر استعجالًا" : ""}
        </option>)}
      </Select>
      <Field label="سبب الأولوية" value={reason} maxLength={2000} disabled={busy || priority === "auto"}
        onChange={event => setReason(event.target.value)} />
      <div className="legal-actions">
        <Button disabled={busy} onClick={() => void save()}>{busy ? "جارٍ الحفظ…" : "حفظ الأولوية"}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => { setEdit(false); setError(""); }}>إلغاء</Button>
      </div>
    </div> : <Button size="compact" variant="secondary" disabled={busy} onClick={() => {
      setPriority(task.task_priority === null ? "auto" : String(task.task_priority));
      setReason(task.task_priority_reason);
      setRevision(task.revision);
      setError("");
      setSaved(false);
      setEdit(true);
    }}>تغيير الأولوية</Button>}
    {error && <Notice tone="error">{error}</Notice>}
    {saved && <span role="status">حُفظت الأولوية وأُعيد ترتيب المهام.</span>}
  </div>;
}

type Comment={id:string;user_name:string;body:string;created_at:string};
type CaseInfo={title:string;case_number:string;agency:string;stage:string;status:string;summary:string;start_date:string|null;next_hearing:string|null};
type Related={id:number;title:string;body:string};
const dateValue=(v:string|null)=>v?new Date(v).toLocaleDateString("ar-YE",{timeZone:"Asia/Aden"}):"غير محدد";
export function LegalTaskBoard({ owner }: { owner: boolean }) {
  const { user } = useSession();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("open");
  const cache=useQueryClient();
  const [caseId,setCaseId]=useState<number|null>(null);
  const [priorityTask,setPriorityTask]=useState<Task|null>(null);
  const [discussion,setDiscussion]=useState<{task:Task;mode:"add"|"view"}|null>(null);
  const [commentText,setCommentText]=useState("");
  const [commentError,setCommentError]=useState("");
  const [commentBusy,setCommentBusy]=useState(false);
  const [commentPage,setCommentPage]=useState(1);
  const caseInfo=useQuery({
    queryKey:["legal","case-popup",user?.id,caseId],
    queryFn:({signal})=>api<{record:CaseInfo}>(`/legal/cases/${caseId}`,{signal}),
    enabled:!!user&&caseId!==null
  });
  const linked=useQuery({
    queryKey:["legal","case-popup-records",user?.id,caseId],
    queryFn:({signal})=>api<{items:Related[]}>(`/legal/cases/${caseId}/records`,{signal}),
    enabled:!!user&&caseId!==null
  });
  const comments=useQuery({
    queryKey:["legal","task-comments",user?.id,discussion?.task.id,commentPage],
    queryFn:({signal})=>api<{items:Comment[];total:number;pageSize:number}>(
      `/legal/tasks/${discussion?.task.id}/comments?page=${commentPage}`,{signal}),
    enabled:!!user&&discussion?.mode==="view"
  });
  const openComments=(task:Task,mode:"add"|"view")=>{
    setDiscussion({task,mode});setCommentPage(1);setCommentText("");setCommentError("");
  };
  async function saveComment(e:FormEvent){
    e.preventDefault();
    if(!discussion||commentBusy||!commentText.trim())return;
    setCommentBusy(true);setCommentError("");
    try {
      await api(`/legal/tasks/${discussion.task.id}/comments`,{method:"POST",body:{body:commentText.trim()}});
      setCommentText("");setCommentPage(1);
      setDiscussion({task:discussion.task,mode:"view"});
      await Promise.all([
        cache.invalidateQueries({queryKey:["legal","task-comments",user?.id,discussion.task.id]}),
        cache.invalidateQueries({queryKey:["legal","task-board",user?.id]})
      ]);
    }catch(e){setCommentError(errorMessage(e));}finally{setCommentBusy(false);}
  }
  const actionButtons=(task:Task)=><div className="legal-task-quick-actions">
    <Button variant="secondary" size="compact" aria-label={`تفاصيل الأولوية ${task.priority}`}
      onClick={()=>setPriorityTask(task)}>{task.priority}</Button>
    <Button variant="secondary" size="compact" onClick={()=>openComments(task,"add")}>{task.follow_up_required?"إدخال الوقائع":"تعليق"}</Button>
    <Button variant="secondary" size="compact" title="عرض التعليقات"
      aria-label={`عرض تعليقات المهمة (${task.comment_count??0})`}
      onClick={()=>openComments(task,"view")}>
      <MessageSquareText size={15}/>{task.comment_count>0?<small>{task.comment_count}</small>:null}
    </Button>
  </div>;

  const query = useQuery({
    queryKey: ["legal", "task-board", user?.id],
    queryFn: ({ signal }) => api<{ items: Task[]; total: number }>("/legal/tasks", { signal }),
    enabled: !!user,
    refetchInterval: 60_000,
  });
  const tasks = useMemo(() => (query.error ? [] : query.data?.items ?? []).filter(task =>
    (filter === "all" || (filter === "open" && task.status !== "verified") ||
      (filter === "done" && task.status === "verified") || filter === String(task.priority)) &&
    (!search || [task.title, task.body, ...task.cases.map(c => c.title)].join(" ").includes(search)),
  ), [query.data, query.error, filter, search]);
  return <Card title="جميع المهام — حسب الأولوية">
    <p>تظهر المهام غير المنجزة أولًا، والأولوية 1 هي الأكثر استعجالًا. تُقيّم الأولوية تلقائيًا من المواعيد والمعطيات المسجلة. المهمة التي يفوت موعدها دون إثبات إنجاز تعود تلقائيًا إلى متابعة اليوم لإدخال ما حدث وتحديد الموعد القادم، مع حفظ تاريخها الأصلي. يمكنك تحديد أولوية لمهمة واحدة أو إعادتها إلى التقييم التلقائي.</p>
    <div className="legal-actions">
      <Field label="بحث في المهام" value={search} onChange={event => setSearch(event.target.value)} />
      <Select label="تصفية المهام" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="open">غير المنجزة</option><option value="all">الكل</option><option value="done">المنجزة</option>
        {Array.from({ length: 10 }, (_, i) => <option key={i} value={String(i + 1)}>أولوية {i + 1}</option>)}
      </Select>
    </div>
    {query.isPending && <Notice>جارٍ تحميل المهام…</Notice>}
    {query.error && <Notice tone="error">{errorMessage(query.error)} <Button variant="secondary" onClick={() => void query.refetch()}>إعادة المحاولة</Button></Notice>}
    {query.data && !query.error && <p>عدد المعروض: {tasks.length} / {query.data.total}</p>}
    {!query.isPending && !query.error && !tasks.length && <Notice>لا توجد مهام مطابقة.</Notice>}
    <div className="legal-task-mobile" aria-label="المهام حسب الأولوية — عرض الهاتف">
      {tasks.map((task, index) => <article className="legal-task-mobile-card" key={task.id}>
        <div className="legal-task-mobile-main">
          <strong className="legal-task-mobile-title">{index + 1}. {task.title}</strong>
          {actionButtons(task)}
        </div>
        <div className="legal-task-mobile-secondary">
          <div className="legal-task-mobile-cases">
            {task.cases.length ? task.cases.map(c => <Button key={c.id} size="compact" variant="secondary"
              onClick={() => setCaseId(c.id)}>{c.title}</Button>) : <span>غير مرتبطة بقضية</span>}
          </div>
          <div className="legal-task-mobile-meta">
            <span>{task.due_at ? new Date(task.due_at).toLocaleDateString("ar-YE", { timeZone: "Asia/Aden" }) : "دون موعد"}</span>
            <span>{labels[task.status] ?? task.status}</span>
          </div>
        </div>
        <details className="legal-task-mobile-details"><summary>تفاصيل المهمة</summary>
          <p className="legal-preserve">{task.body}</p>
        </details>
      </article>)}
    </div>
    <div className="legal-task-scroll"><table className="legal-task-table" aria-label="المهام حسب الأولوية">
      <thead><tr><th scope="col">#</th><th scope="col">الأولوية والتعليقات</th><th scope="col">المهمة</th><th scope="col">القضية</th><th scope="col">الموعد</th><th scope="col">الحالة</th></tr></thead>
      <tbody>{tasks.map((task, index) => <tr key={task.id}>
        <td>{index + 1}</td><td>{actionButtons(task)}</td>
        <td><strong>{task.title}</strong><details><summary>التفاصيل</summary><p className="legal-preserve">{task.body}</p></details></td>
        <td>{task.cases.length ? task.cases.map(c => <Button key={c.id} size="compact" variant="secondary"
          onClick={() => setCaseId(c.id)}>{c.title}</Button>) : "غير مرتبطة"}</td>
        <td>{task.due_at ? new Date(task.due_at).toLocaleDateString("ar-YE", { timeZone: "Asia/Aden" }) : "غير محدد"}</td>
        <td>{labels[task.status] ?? task.status}</td>
      </tr>)}</tbody>
    </table></div>
    <Dialog open={caseId!==null} onClose={()=>setCaseId(null)}
      title={caseInfo.data?.record.title??"تفاصيل القضية"}>
      {caseInfo.isPending&&<Notice>جارٍ تحميل بيانات القضية…</Notice>}
      {caseInfo.error&&<Notice tone="error">{errorMessage(caseInfo.error)}</Notice>}
      {caseInfo.data&&<div className="legal-task-popup-body">
        <p><strong>رقم القضية:</strong> {caseInfo.data.record.case_number||"غير محدد"}</p>
        <p><strong>الجهة:</strong> {caseInfo.data.record.agency||"غير محددة"}</p>
        <p><strong>المرحلة:</strong> {caseInfo.data.record.stage||"غير محددة"}</p>
        <p><strong>الحالة:</strong> {caseInfo.data.record.status}</p>
        <p><strong>تاريخ البدء:</strong> {dateValue(caseInfo.data.record.start_date)} · <strong>الجلسة القادمة:</strong> {dateValue(caseInfo.data.record.next_hearing)}</p>
        <p className="legal-preserve">{caseInfo.data.record.summary}</p>
        <h3>السجلات المرتبطة بالقضية</h3>
        {linked.isPending&&<Notice>جارٍ تحميل السجلات…</Notice>}
        {linked.error&&<Notice tone="error">{errorMessage(linked.error)}</Notice>}
        {linked.data?.items.length===0&&<p>لا توجد سجلات مرتبطة.</p>}
        {linked.data?.items.map(record=><details key={record.id}>
          <summary>{record.title}</summary><p className="legal-preserve">{record.body}</p>
        </details>)}
      </div>}
    </Dialog>
    <Dialog open={priorityTask!==null} onClose={()=>setPriorityTask(null)} title="معلومات الأولوية">
      {priorityTask&&<div className="legal-task-popup-body">
        <p><strong>الأولوية:</strong> {priorityTask.priority} من 10 (1 الأكثر استعجالًا).</p>
        <p><strong>نوعها:</strong> {priorityTask.source==="manual"?"يدوية، حددها المالك":"تلقائية، محسوبة من المواعيد والمعطيات"}</p>
        {priorityTask.reason&&<p className="legal-preserve">{priorityTask.reason}</p>}
        {owner&&<LegalTaskPriorityControl key={`${priorityTask.id}-${priorityTask.revision}`} task={priorityTask}/>}
      </div>}
    </Dialog>
    <Dialog open={discussion!==null} onClose={()=>setDiscussion(null)}
      title={discussion?.task.title??"تعليقات المهمة"}>
      {discussion?.mode==="add"&&<form className="legal-task-popup-body" onSubmit={e=>void saveComment(e)}>
        <label htmlFor="legal-task-comment-input">{discussion.task.follow_up_required?"ما الوقائع التي حدثت؟ وما القرار والموعد القادم؟":"ماذا تم في هذه المهمة؟"}</label>
        <textarea id="legal-task-comment-input" maxLength={2000} rows={4} required
          value={commentText} onChange={e=>setCommentText(e.target.value)}
          placeholder={discussion.task.follow_up_required?"أدخل ما حدث فعلًا، وقرار الجلسة أو نتيجة الإجراء، وتاريخ الجلسة التالية إن عُرف؛ حدّث موعد القضية من بطاقتها.":"مثال: تمت مراجعة المحكمة وتسليم المذكرة…"}/>
        {commentError&&<Notice tone="error">{commentError}</Notice>}
        <div className="legal-task-quick-actions">
          <Button type="submit" disabled={commentBusy||!commentText.trim()}>
            {commentBusy?"جارٍ الحفظ…":"حفظ التعليق"}
          </Button>
          <Button variant="secondary" onClick={()=>setDiscussion(prev=>prev?{...prev,mode:"view"}:null)}>عرض التعليقات</Button>
        </div>
      </form>}
      {discussion?.mode==="view"&&<div className="legal-task-popup-body">
        <Button variant="secondary" size="compact" onClick={()=>setDiscussion(prev=>prev?{...prev,mode:"add"}:null)}>إضافة تعليق</Button>
        {comments.isPending&&<Notice>جارٍ تحميل التعليقات…</Notice>}
        {comments.error&&<Notice tone="error">{errorMessage(comments.error)}</Notice>}
        {comments.data?.items.length===0&&<Notice>لا توجد تعليقات بعد.</Notice>}
        {comments.data?.items.map(comment=><article className="legal-task-comment-entry" key={comment.id}>
          <strong>{comment.user_name}</strong> · <small>{new Date(comment.created_at).toLocaleString("ar-YE",{timeZone:"Asia/Aden"})}</small>
          <p className="legal-preserve">{comment.body}</p>
        </article>)}
        {comments.data&&<div className="legal-task-quick-actions">
          <span>{comments.data.total} تعليق</span>
          <Button variant="secondary" size="compact" disabled={commentPage<=1} onClick={()=>setCommentPage(v=>v-1)}>السابق</Button>
          <Button variant="secondary" size="compact" disabled={commentPage*comments.data.pageSize>=comments.data.total} onClick={()=>setCommentPage(v=>v+1)}>التالي</Button>
        </div>}
      </div>}
    </Dialog>
  </Card>;
}
