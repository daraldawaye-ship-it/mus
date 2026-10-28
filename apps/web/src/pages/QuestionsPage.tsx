import { useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

type Question = {
  id:number; companyId:number|null; category:string; priority:number; question:string;
  options:string[]; optionCount:number; correctAnswer:number|null; points:number;
  active:boolean; revision:number; creatorName:string; createdAt:string;
  answerCount:number; respondentCount:number; myAnswerCount:number; myLastAnsweredAt:string|null;
};
type Answer = {
  id:string; questionId:number; userId:number; userName:string; question:string;
  selectedAnswer:number; selectedText:string; correct:boolean; points:number;
  comment:string|null; answeredAt:string;
};
type Page<T>={items:T[];total:number;page:number;pageSize:number};
type Draft={
  category:string;priority:number;question:string;options:string[];
  correctAnswer:number;points:number;active:boolean;
};
type Submission = {selectedAnswer:number;comment:string|null;idempotencyKey:string};
const blank=():Draft=>({category:"",priority:1,question:"",options:["","","",""],correctAnswer:1,points:1,active:true});
const date=(value:string|null)=>value
  ? new Intl.DateTimeFormat("ar-YE",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Aden"}).format(new Date(value))
  : "لم يُجب بعد";
function shuffled(size:number){
  const choices=Array.from({length:size},(_,i)=>i);
  for(let i=choices.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [choices[i],choices[j]]=[choices[j]!,choices[i]!];
  }
  return choices;
}

export function QuestionsPage({companyId=null,tab="questions"}:{
  companyId?:number|null;tab?:"questions"|"answers";
}) {
  const {user}=useSession(), client=useQueryClient();
  const scope=companyId===null?"public":`company:${companyId}`;
  const base=companyId===null?"":`/companies/${companyId}`;
  const root=`${base}/questions`,answersRoot=`${base}/answers`;
  const directory=usePageDirectory(companyId??undefined);
  const scopeName=companyId===null?"public":"company";
  const questionsEntry=directory.data?.find(v=>v.key===`${scopeName}.questions`);
  const answersEntry=directory.data?.find(v=>v.key===`${scopeName}.answers`);
  const canEdit=!!questionsEntry?.enabled && !!questionsEntry.actionAccess.edit;
  const canCreate=!!questionsEntry?.enabled && !!questionsEntry.actionAccess.create;
  const canAnswer=!!answersEntry?.enabled && !!answersEntry.actionAccess.create;
  const visible=tab==="questions"?questionsEntry:answersEntry;
  const [params]=useSearchParams();
  const [query,setQuery]=useState(params.get("q")??"");
  const [page,setPage]=useState(1);
  const questionId=params.get("questionId");
  const [opened,setOpened]=useState<number|null>(null);
  const [chosen,setChosen]=useState<number|null>(null);
  const [order,setOrder]=useState<number[]>([]);
  const [comment,setComment]=useState("");
  const [pendingAnswer,setPendingAnswer]=useState<Submission|null>(null);
  const [sending,setSending]=useState(false);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [editing,setEditing]=useState<Question|null>(null);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const url=useMemo(()=>{
    const search=new URLSearchParams({page:String(page),pageSize:"20",q:query});
    if(tab==="answers"&&questionId)search.set("questionId",questionId);
    return `${tab==="questions"?root:answersRoot}?${search}`;
  },[page,query,root,answersRoot,tab,questionId]);
  const list=useQuery({
    queryKey:["questions-module",user?.id,scope,tab,url],
    queryFn:({signal})=>api<Page<Question> | Page<Answer>>(url,{signal}),
    enabled:!!user && !!visible?.enabled && !!visible.actionAccess.view,
  });
  const questions=tab==="questions"?(list.data?.items??[]) as Question[]:[];
  const responses=tab==="answers"?(list.data?.items??[]) as Answer[]:[];
  function openAnswer(question:Question) {
    setOpened(prev=>prev===question.id?null:question.id);
    setOrder(shuffled(question.options.length));setChosen(null);setComment("");setPendingAnswer(null);
    setError("");setMessage("");
  }
  async function submitAnswer(event:FormEvent,question:Question) {
    event.preventDefault();
    if(sending||!canAnswer)return;
    const payload=pendingAnswer??(chosen===null?null:{
      selectedAnswer:chosen,comment:comment.trim()||null,idempotencyKey:crypto.randomUUID()
    });
    if(!payload){setError("اختر إجابة من الخيارات المتاحة");return;}
    setPendingAnswer(payload);setSending(true);setError("");setMessage("");
    try{
      const result=await api<{correct:boolean;points:number}>(`${root}/${question.id}/answers`,{method:"POST",body:payload});
      setPendingAnswer(null);setOpened(null);setComment("");setChosen(null);
      setMessage(result.correct?`إجابة صحيحة، حصلت على ${result.points} نقطة.`:"تم تسجيل الإجابة. يمكنك الإجابة عن هذا السؤال مرة أخرى.");
      void client.invalidateQueries({queryKey:["questions-module",user?.id,scope]});
    }catch(cause){setError(errorMessage(cause));}
    finally{setSending(false);}
  }
  function startEdit(question:Question|null) {
    setEditing(question);
    setDraft(question?{
      category:question.category,priority:question.priority,question:question.question,
      options:[...question.options],correctAnswer:question.correctAnswer??1,points:question.points,active:question.active
    }:blank());
    setError("");setMessage("");
  }
  async function saveQuestion(event:FormEvent){
    event.preventDefault();
    if(!draft||saving)return;
    if(!draft.question.trim()||draft.options.some(v=>!v.trim())){setError("أدخل السؤال وجميع الخيارات الظاهرة");return;}
    setSaving(true);setError("");setMessage("");
    try{
      await api(editing?`${root}/${editing.id}`:root,{
        method:editing?"PUT":"POST",body:editing?{...draft,revision:editing.revision}:draft,
      });
      setDraft(null);setEditing(null);setMessage("تم حفظ السؤال بنجاح");
      await client.invalidateQueries({queryKey:["questions-module",user?.id,scope]});
    }catch(cause){setError(errorMessage(cause));}
    finally{setSaving(false);}
  }
  if(!user)return <Notice tone="warning">يجب تسجيل الدخول لعرض الأسئلة.</Notice>;
  if(!visible?.enabled||!visible.actionAccess.view)return <Notice tone="warning">هذه الصفحة غير متاحة لصلاحيات حسابك.</Notice>;
  return <div>
    <PageHeader title={tab==="questions"?"الأسئلة والخيارات":"سجل الإجابات"}
      description={companyId===null?"أسئلة الموقع العام":"أسئلة هذه الشركة فقط، مستقلة عن الشركات الأخرى"}
      actions={<>
        <Link to={root} className="button button-secondary button-compact">قائمة الأسئلة</Link>
        {answersEntry?.actionAccess.view && <Link to={answersRoot} className="button button-secondary button-compact">آخر الإجابات</Link>}
        {tab==="questions"&&canCreate&&<Button onClick={()=>startEdit(null)}>إضافة سؤال</Button>}
      </>} />
    {message&&<Notice tone="success">{message}</Notice>}
    {error&&<Notice tone="error">{error}</Notice>}
    {draft&&tab==="questions"&&<Card title={editing?"تعديل كرت السؤال":"كرت سؤال جديد"}>
      <form onSubmit={event=>void saveQuestion(event)} className="stack">
        <div className="form-grid">
          <Field label="الفئة" value={draft.category} maxLength={120} onChange={e=>setDraft({...draft,category:e.target.value})}/>
          <Field label="الأولوية (1 الأعلى)" type="number" min={1} max={100} value={draft.priority} onChange={e=>setDraft({...draft,priority:Number(e.target.value)})} required/>
          <Select label="عدد الخيارات" value={draft.options.length}
            onChange={e=>{
              const length=Number(e.target.value);
              const options=Array.from({length},(_,i)=>draft.options[i]??"");
              setDraft({...draft,options,correctAnswer:Math.min(draft.correctAnswer,length)});
            }}>
            <option value={4}>4 خيارات (الافتراضي)</option>
            <option value={3}>3 خيارات</option>
            <option value={2}>خياران</option>
          </Select>
          <Field label="نقاط الجواب" type="number" min={0} max={100000} value={draft.points} onChange={e=>setDraft({...draft,points:Number(e.target.value)})} required/>
        </div>
        <div className="field"><label htmlFor="question-body">السؤال</label>
          <textarea id="question-body" value={draft.question} maxLength={2000} rows={3} required
            onChange={e=>setDraft({...draft,question:e.target.value})}/>
        </div>
        {draft.options.map((option,i)=><Field key={i} label={`الجواب ${i+1}`} value={option}
          maxLength={1000} required onChange={e=>setDraft({...draft,options:draft.options.map((old,j)=>j===i?e.target.value:old)})}/>)}
        <Select label="رقم الجواب الصحيح" value={draft.correctAnswer}
          onChange={e=>setDraft({...draft,correctAnswer:Number(e.target.value)})}>
          {draft.options.map((_,i)=><option key={i} value={i+1}>الجواب {i+1}</option>)}
        </Select>
        <label><input type="checkbox" checked={draft.active} onChange={e=>setDraft({...draft,active:e.target.checked})}/> السؤال فعال ويظهر للمستخدمين</label>
        <div className="page-actions">
          <Button type="submit" disabled={saving}>{saving?"جارٍ الحفظ…":"حفظ السؤال"}</Button>
          <Button variant="secondary" onClick={()=>{setDraft(null);setEditing(null);}}>إلغاء</Button>
        </div>
      </form>
    </Card>}
    <Card title={tab==="questions"?"قائمة الأسئلة وتفاصيلها":"آخر الإجابات والتعليقات"}>
      <div className="table-filters">
        <Field type="search" label="بحث" value={query}
          placeholder={tab==="questions"?"السؤال أو الفئة":"السؤال أو المستخدم أو التعليق"}
          onChange={e=>{setQuery(e.target.value);setPage(1);}} />
      </div>
      {list.isFetching&&!list.data&&<Notice>جارٍ تحميل السجلات…</Notice>}
      {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
      {tab==="questions"&&questions.map(question=><article key={question.id} className="card" style={{marginBlock:"0.75rem",padding:"0.8rem"}}>
        <div className="page-actions" style={{justifyContent:"space-between",flexWrap:"wrap"}}>
          <strong>{question.question}</strong>
          <span>{question.category||"بدون فئة"} · الأولوية {question.priority} · {question.options.length} خيارات</span>
        </div>
        <p>أنشئ بواسطة: {question.creatorName} · {date(question.createdAt)} · نقاط الجواب: {question.points}</p>
        <p>الإجابات: {question.answerCount} · المستخدمون: {question.respondentCount} · إجاباتك: {question.myAnswerCount} · آخر إجابة لك: {date(question.myLastAnsweredAt)}</p>
        {canEdit&&<div className="page-actions">
          <Button variant="secondary" size="compact" onClick={()=>startEdit(question)}>تعديل الكرت</Button>
          {!question.active&&<span>السؤال غير فعال</span>}
        </div>}
        {question.active&&canAnswer&&<Button variant="secondary" size="compact"
          onClick={()=>openAnswer(question)}>{opened===question.id?"إغلاق":"الإجابة عن السؤال"}</Button>}
        {answersEntry?.actionAccess.view&&<Link className="button button-secondary button-compact" to={`${answersRoot}?questionId=${question.id}`}>عرض الإجابات</Link>}
        {opened===question.id&&question.active&&<form onSubmit={event=>void submitAnswer(event,question)} className="stack" style={{marginBlockStart:"0.8rem"}}>
          <fieldset disabled={sending||!!pendingAnswer}>
            <legend>اختر الإجابة الصحيحة</legend>
            {order.map(i=><label key={i} style={{display:"block",marginBlock:"0.4rem"}}>
              <input type="radio" name={`question-choice-${question.id}`}
                checked={chosen===i+1} onChange={()=>setChosen(i+1)} />
              {" "}{question.options[i]}
            </label>)}
          </fieldset>
          <div className="field"><label htmlFor={`comment-${question.id}`}>تعليق (اختياري)</label>
            <textarea id={`comment-${question.id}`} rows={3} maxLength={2000}
              disabled={sending||!!pendingAnswer} value={comment}
              placeholder="يمكنك توضيح سبب اختيارك أو إضافة ملاحظة"
              onChange={e=>setComment(e.target.value)}/>
          </div>
          <Button type="submit" disabled={sending||chosen===null}>
            {sending?"جارٍ التسجيل…":pendingAnswer?"إعادة إرسال المحاولة":"إرسال الإجابة"}
          </Button>
        </form>}
      </article>)}
      {tab==="answers"&&responses.map(answer=><article key={answer.id} className="card" style={{marginBlock:"0.75rem",padding:"0.8rem"}}>
        <div><strong>{answer.question}</strong></div>
        <p>{answer.userName} · {date(answer.answeredAt)} · السؤال #{answer.questionId}</p>
        <p>الجواب {answer.selectedAnswer}: {answer.selectedText} · {answer.correct?"صحيح":"غير صحيح"} · {answer.points} نقطة</p>
        {answer.comment&&<p style={{whiteSpace:"pre-wrap"}}>التعليق: {answer.comment}</p>}
      </article>)}
      {list.data?.items.length===0&&<Notice>لا توجد سجلات مطابقة.</Notice>}
      {!!list.data&&<div className="page-actions">
        <span>العدد: {list.data.total} · صفحة {page}</span>
        <Button variant="secondary" size="compact" disabled={page<=1} onClick={()=>setPage(v=>v-1)}>السابق</Button>
        <Button variant="secondary" size="compact" disabled={page*20>=list.data.total} onClick={()=>setPage(v=>v+1)}>التالي</Button>
      </div>}
    </Card>
  </div>;
}
