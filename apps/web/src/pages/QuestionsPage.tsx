import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Info } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiFailure, useSession } from "../api";
import { offlineChanged, pendingForUser, personalAnswerHistory, queueOfflineOperation, storePersonalAnswer } from "../offline-storage";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { visibleQuestionResult, type QuestionResult } from "../question-result";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

type Question = {
  id:number; companyId:number|null; category:string; priority:number; question:string;
  options:string[]; optionCount:number; correctAnswer:number|null; points:number;
  active:boolean; revision:number; creatorName:string; createdAt:string;
  answerCount:number; respondentCount:number; myAnswerCount:number; myLastAnsweredAt:string|null;
  myLastSelectedAnswer:number|null; myLastCorrect:boolean|null; myLastPoints:number|null;
  myLastComment:string|null; otherOptionCounts:number[]|null;
};
type Answer = {
  id:string; questionId:number; userId:number; userName:string; question:string;
  selectedAnswer:number; selectedText:string; correct:boolean; points:number;
  comment:string|null; answeredAt:string;
};
type Page<T>={items:T[];total:number;page:number;pageSize:number};
type CategoryList={items:{category:string;count:number}[]};
type Draft={
  category:string;priority:number;question:string;options:string[];
  correctAnswer:number;points:number;active:boolean;
};
type Submission = {selectedAnswer:number;comment:string|null;idempotencyKey:string};
type AnswerOutcome = QuestionResult;
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
  const [params,setParams]=useSearchParams();
  const selectedCategory=params.get("category");
  const categorySelected=selectedCategory!==null;
  const [query,setQuery]=useState(params.get("q")??"");
  const [page,setPage]=useState(1);
  const [statusFilter,setStatusFilter]=useState<"active"|"archived">("active");
  const questionId=params.get("questionId");
  const [infoId,setInfoId]=useState<number|null>(null);
  const infoWrap=useRef<HTMLDivElement|null>(null);
  const editorRef=useRef<HTMLDivElement|null>(null);
  const optionOrders=useRef<Map<number,number[]>>(new Map());
  const [chosenAnswers,setChosenAnswers]=useState<Record<number,number>>({});
  const [comments,setComments]=useState<Record<number,string>>({});
  const [pendingAnswers,setPendingAnswers]=useState<Record<number,Submission>>({});
  const [queuedAnswers,setQueuedAnswers]=useState<Record<number,boolean>>({});
  useEffect(() => {
    if (!user?.id) return;
    const refresh = () => {
      void pendingForUser(user.id).then(rows => {
        const queued: Record<number, boolean> = {};
        const prefix = root + "/";
        for (const row of rows) {
          if (row.kind !== "answer" || !row.path.startsWith(prefix)) continue;
          const match = row.path.match(/\/(\d+)\/answers$/);
          if (match) queued[Number(match[1])] = true;
        }
        setQueuedAnswers(queued);
      }).catch(() => {});
    };
    refresh();
    return offlineChanged(refresh);
  }, [user?.id, root]);

  const [savedAnswers,setSavedAnswers]=useState<Record<number,AnswerOutcome>>({});
  const [confirmedAnswers,setConfirmedAnswers]=useState<Record<number,AnswerOutcome>>({});
  useEffect(() => {
    if (!user?.id) { setSavedAnswers({}); return; }
    const currentUser = user.id;
    let active = true;
    const refresh = () => {
      void personalAnswerHistory(currentUser, scope).then(rows => {
        if (active) setSavedAnswers(rows);
      }).catch(() => {});
    };
    refresh();
    const onOnline = () => {
      if (active) void client.invalidateQueries({
        queryKey:["questions-module",currentUser,scope],
      });
    };
    const off = offlineChanged(refresh);
    window.addEventListener("online", onOnline);
    return () => { active = false; off(); window.removeEventListener("online",onOnline); };
  }, [user?.id,scope,client]);
  const [frozenQuestions,setFrozenQuestions]=useState<{url:string;items:Question[]}|null>(null);
  const [sendingQuestionId,setSendingQuestionId]=useState<number|null>(null);
  const sendingQuestionRef=useRef<number|null>(null);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [editing,setEditing]=useState<Question|null>(null);
  const [saving,setSaving]=useState(false);
  const [statusBusyId,setStatusBusyId]=useState<number|null>(null);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const categories=useQuery({
    queryKey:["question-categories",user?.id,scope],
    queryFn:({signal})=>api<CategoryList>(`${root}/categories`,{signal}),
    enabled:tab==="questions" && !!user && !!questionsEntry?.enabled && !!questionsEntry.actionAccess.view,
  });
  const url=useMemo(()=>{
    const search=new URLSearchParams({page:String(page),pageSize:"20",q:query});
    if(tab==="questions" && selectedCategory!==null) search.set("category",selectedCategory);
    if(tab==="questions") search.set("status",statusFilter);
    if(tab==="answers"&&questionId)search.set("questionId",questionId);
    return `${tab==="questions"?root:answersRoot}?${search}`;
  },[page,query,root,answersRoot,tab,questionId,selectedCategory,statusFilter]);
  const list=useQuery({
    queryKey:["questions-module",user?.id,scope,tab,url],
    queryFn:({signal})=>api<Page<Question> | Page<Answer>>(url,{signal}),
    enabled:!!user && !!visible?.enabled && !!visible.actionAccess.view &&
      (tab==="answers" || categorySelected),
  });
  const liveQuestions=tab==="questions"?(list.data?.items??[]) as Question[]:[];
  function refreshQuestions(){
    if(list.isFetching)return;
    setInfoId(null);
    setFrozenQuestions(null);
    setConfirmedAnswers({});
    setPage(1);
    void client.invalidateQueries({queryKey:["questions-module",user?.id,scope,tab]});
    window.scrollTo({top:0,behavior:"smooth"});
  }
  // Retain current-page order even if focus-triggered/background refetch sorts answered
  // questions to a later page. New page/search navigation uses live server ordering.
  const questions=frozenQuestions?.url===url
    ? frozenQuestions.items.map(old=>liveQuestions.find(item=>item.id===old.id)??old)
    : liveQuestions;
  const responses=tab==="answers"?(list.data?.items??[]) as Answer[]:[];
  useEffect(()=>{
    if(draft) editorRef.current?.scrollIntoView({behavior:"smooth",block:"start"});
  },[!!draft,editing?.id]);
  useEffect(()=>{
    if(infoId===null)return;
    const dismiss=(event:PointerEvent)=>{
      if(!infoWrap.current?.contains(event.target as Node))setInfoId(null);
    };
    const escape=(event:KeyboardEvent)=>{
      if(event.key==="Escape")setInfoId(null);
    };
    document.addEventListener("pointerdown",dismiss);
    document.addEventListener("keydown",escape);
    return ()=>{
      document.removeEventListener("pointerdown",dismiss);
      document.removeEventListener("keydown",escape);
    };
  },[infoId]);
  function optionOrder(question:Question){
    const existing=optionOrders.current.get(question.id);
    if(existing&&existing.length===question.options.length)return existing;
    const next=shuffled(question.options.length);
    optionOrders.current.set(question.id,next);
    return next;
  }
  function selectCategory(category:string|null){
    setPage(1);setQuery("");setInfoId(null);setStatusFilter("active");
    setPendingAnswers({});setFrozenQuestions(null);setConfirmedAnswers({});setError("");setMessage("");
    setParams(current=>{
      const next=new URLSearchParams(current);
      if(category===null)next.delete("category");
      else next.set("category",category);
      next.delete("q");
      return next;
    });
  }
  function outcomeFor(question:Question): AnswerOutcome|null {
    return visibleQuestionResult(question,savedAnswers[question.id],confirmedAnswers[question.id]);
  }
  async function submitAnswer(question:Question,selectedAnswer:number) {
    // The click is the submission: capture the choice directly, without waiting
    // for React's state update or a separate confirmation button.
    if(sendingQuestionRef.current!==null||!canAnswer||outcomeFor(question)||!question.active||queuedAnswers[question.id])return;
    const comment=comments[question.id]?.trim()||null;
    const previous=pendingAnswers[question.id];
    // A retry of the same choice must reuse its idempotency key.
    const payload:Submission=previous?.selectedAnswer===selectedAnswer&&previous.comment===comment
      ? previous : {selectedAnswer,comment,idempotencyKey:crypto.randomUUID()};
    sendingQuestionRef.current=question.id;
    setChosenAnswers(prev=>({...prev,[question.id]:selectedAnswer}));
    setPendingAnswers(prev=>({...prev,[question.id]:payload}));
    setSendingQuestionId(question.id);setError("");setMessage("");
    try{
      const result=await api<AnswerOutcome>(`${root}/${question.id}/answers`,{method:"POST",body:payload});
      const confirmed={...result,selectedAnswer:payload.selectedAnswer,comment:payload.comment};
      setConfirmedAnswers(prev=>({...prev,[question.id]:confirmed}));
      setSavedAnswers(prev=>({...prev,[question.id]:confirmed}));
      if (user?.id)
        await storePersonalAnswer(user.id,scope,question.id,confirmed).catch(() => {});
      setPendingAnswers(prev=>{const next={...prev};delete next[question.id];return next;});
      setFrozenQuestions({url,items:questions});
      void client.invalidateQueries({queryKey:["questions-module",user?.id,scope]});
    }catch(cause){
      const uncertain=!(cause instanceof ApiFailure)||cause.status>=500;
      if(uncertain && user?.id){
        try{
          await queueOfflineOperation(user.id,companyId,"answer",
            root+"/"+question.id+"/answers",payload);
          setQueuedAnswers(prev=>({...prev,[question.id]:true}));
          setMessage("تم حفظ إجابتك على هذا الجهاز. لم تُحتسب النقاط حتى تأكيد الخادم عند المزامنة.");
        }catch(localError){setError("تعذر الحفظ المحلي: "+errorMessage(localError));}
      }else setError(errorMessage(cause));
    }
    finally{sendingQuestionRef.current=null;setSendingQuestionId(null);}
  }
  function startEdit(question:Question|null) {
    setEditing(question);
    setDraft(question?{
      category:question.category,priority:question.priority,question:question.question,
      options:[...question.options],correctAnswer:question.correctAnswer??1,points:question.points,active:question.active
    }:blank());
    setInfoId(null);setError("");setMessage("");
  }
  async function updateQuestionStatus(question:Question,active:boolean){
    if(!canEdit||statusBusyId!==null||question.active===active)return;
    setStatusBusyId(question.id);setError("");setMessage("");
    try {
      await api(`${root}/${question.id}/status`,{
        method:"PATCH",body:{active,revision:question.revision}
      });
      setInfoId(null);
      setFrozenQuestions(null);
      setMessage(active?"تمت استعادة السؤال من الأرشيف.":"تمت أرشفة السؤال مع الاحتفاظ بإجاباته.");
      await Promise.all([
        client.invalidateQueries({queryKey:["question-categories",user?.id,scope]}),
        client.invalidateQueries({queryKey:["questions-module",user?.id,scope]})
      ]);
    }catch(cause){setError(errorMessage(cause));}
    finally{setStatusBusyId(null);}
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
      const savedCategory=draft.category.trim(), savedActive=draft.active;
      setDraft(null);setEditing(null);
      selectCategory(savedCategory);
      if(!savedActive)setStatusFilter("archived");
      setMessage("تم حفظ السؤال بنجاح");
      await Promise.all([
        client.invalidateQueries({queryKey:["question-categories",user?.id,scope]}),
        client.invalidateQueries({queryKey:["questions-module",user?.id,scope]})
      ]);
    }catch(cause){setError(errorMessage(cause));}
    finally{setSaving(false);}
  }
  if(!user)return <Notice tone="warning">يجب تسجيل الدخول لعرض الأسئلة.</Notice>;
  if(!visible?.enabled||!visible.actionAccess.view)return <Notice tone="warning">هذه الصفحة غير متاحة لصلاحيات حسابك.</Notice>;
  return <div>
    <PageHeader title={tab==="questions"?"الأسئلة والخيارات":"سجل الإجابات"}
      actions={<>
        {tab==="answers"&&<Link to={root} className="button button-secondary button-compact">الأسئلة</Link>}
        {tab==="questions"&&canCreate&&<Button onClick={()=>startEdit(null)}>إضافة سؤال</Button>}
      </>} />
    {tab==="questions"&&<div className="question-category-list" role="group" aria-label="فئات الأسئلة">
      {categories.isLoading&&<Notice>جارٍ تحميل الفئات…</Notice>}
      {categories.error&&<Notice tone="error">{errorMessage(categories.error)}</Notice>}
      {categories.data?.items.map(item=><Button key={item.category}
        variant={selectedCategory===item.category?"primary":"secondary"} size="compact"
        aria-pressed={selectedCategory===item.category}
        onClick={()=>selectCategory(item.category)}>
        {item.category||"بدون فئة"} ({item.count})
      </Button>)}
      {categories.data?.items.length===0&&<Notice>لا توجد فئات أسئلة حتى الآن.</Notice>}
    </div>}
    {message&&<Notice tone="success">{message}</Notice>}
    {error&&<Notice tone="error">{error}</Notice>}
    {draft&&tab==="questions"&&<div className="question-editor" ref={editorRef}><Card title={editing?"تعديل كرت السؤال":"كرت سؤال جديد"}>
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
        <label><input type="checkbox" checked={draft.active} onChange={e=>setDraft({...draft,active:e.target.checked})}/> السؤال فعال ويظهر للمستخدمين (إلغاء التفعيل ينقله للأرشيف)</label>
        <div className="page-actions">
          <Button type="submit" disabled={saving}>{saving?"جارٍ الحفظ…":"حفظ السؤال"}</Button>
          <Button variant="secondary" onClick={()=>{setDraft(null);setEditing(null);}}>إلغاء</Button>
        </div>
      </form>
    </Card></div>}
    {(tab==="answers"||categorySelected)&&<section className="question-results">
      <div className="question-search">
        <Field className="question-search-field" type="search" label="بحث" value={query}
          onChange={e=>{setQuery(e.target.value);setPage(1);setFrozenQuestions(null);}} />
        {tab==="questions"&&canEdit&&<Select label="عرض الأسئلة" value={statusFilter}
          onChange={e=>{setStatusFilter(e.target.value as "active"|"archived");setPage(1);setInfoId(null);setFrozenQuestions(null);}}>
          <option value="active">الأسئلة النشطة</option>
          <option value="archived">أرشيف الأسئلة</option>
        </Select>}
      </div>
      {list.isFetching&&!list.data&&<Notice>جارٍ تحميل السجلات…</Notice>}
      {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
      {tab==="questions"&&questions.map(question=>{
        const answered=outcomeFor(question);
        const isSending=sendingQuestionId===question.id;
        const isInfoOpen=infoId===question.id;
        return <article key={question.id} className="card question-card">
          <div className="question-card-heading">
            <strong>{question.question}</strong>
            <div className="question-info-wrap" ref={isInfoOpen?infoWrap:undefined}>
              <button type="button" className="question-info-button" aria-label="معلومات السؤال"
                aria-expanded={isInfoOpen} aria-haspopup="dialog"
                onClick={()=>setInfoId(prev=>prev===question.id?null:question.id)}>
                <Info size={18}/>
              </button>
              {isInfoOpen&&<div className="question-info-popover" role="dialog" aria-label="معلومات السؤال">
                <p><strong>الفئة:</strong> {question.category||"بدون فئة"}</p>
                <p><strong>الأولوية:</strong> {question.priority} · <strong>الخيارات:</strong> {question.optionCount}</p>
                <p><strong>النقاط:</strong> {question.points} · <strong>الحالة:</strong> {question.active?"فعال":"غير فعال"}</p>
                <p><strong>أُنشئ بواسطة:</strong> {question.creatorName}</p>
                <p><strong>تاريخ الإنشاء:</strong> {date(question.createdAt)}</p>
                <p><strong>الإجابات:</strong> {question.answerCount} · <strong>المستخدمون:</strong> {question.respondentCount}</p>
                <p><strong>إجاباتك:</strong> {question.myAnswerCount} · <strong>آخر إجابة:</strong> {date(question.myLastAnsweredAt)}</p>
                <p className="question-info-note">نقاط الإجابة الصحيحة تُمنح في المحاولة الأولى فقط.</p>
                {canEdit&&<div className="actions">
                  <Button variant="secondary" size="compact" onClick={()=>startEdit(question)}>تعديل الكرت</Button>
                  <Button variant="secondary" size="compact" disabled={statusBusyId!==null}
                    onClick={()=>void updateQuestionStatus(question,!question.active)}>
                    {statusBusyId===question.id?"جارٍ الحفظ…":question.active?"أرشفة السؤال":"استعادة من الأرشيف"}
                  </Button>
                </div>}
              </div>}
            </div>
          </div>
          {queuedAnswers[question.id]&&<p role="status">الإجابة محفوظة محليًا، وتنتظر المزامنة ولا تُحسب نقاطها بعد.</p>}
          {answered&&<div className={`question-result ${answered.correct?"question-result-correct":"question-result-wrong"}`}
            role="status" aria-live="polite">
            <strong>{answered.correct?"✓ إجابتك صحيحة":"✗ إجابتك خاطئة"}</strong>
            {!answered.correct&&answered.correctAnswer!==null&&
              question.options[answered.correctAnswer-1]&&
              <span>الإجابة الصحيحة: {question.options[answered.correctAnswer-1]}</span>}
            {answered.points>0&&<span>+{answered.points} نقطة</span>}
          </div>}
          <div className="question-answer-form">
            <fieldset className="question-options" disabled={!!answered||!!queuedAnswers[question.id]||!canAnswer||!question.active||isSending}>
              <legend className="sr-only">اختر إجابة السؤال</legend>
              {optionOrder(question).map(i=><label key={i}
                className={`question-choice${answered?.selectedAnswer===i+1?" question-choice-selected":""}${answered?.correctAnswer===i+1?" question-choice-correct":""}${answered&&!answered.correct&&answered.selectedAnswer===i+1?" question-choice-wrong":""}`}>
                <input type="radio" name={`question-choice-${question.id}`}
                  checked={(answered?.selectedAnswer??chosenAnswers[question.id])===i+1}
                  onChange={()=>void submitAnswer(question,i+1)}
                  onClick={()=>void submitAnswer(question,i+1)}/>
                <span className="question-choice-content">
                  <span>{question.options[i]}</span>
                  {answered&&<span className="question-choice-stat">
                    {answered.otherOptionCounts?.[i]??0} من الآخرين
                    {answered.selectedAnswer===i+1?" · اختيارك":""}
                    {answered.correctAnswer===i+1?" · ✓ الإجابة الصحيحة":""}
                    {answered.selectedAnswer===i+1&&!answered.correct?" · ✗ إجابة خاطئة":""}
                  </span>}
                </span>
              </label>)}
            </fieldset>
            {answered?<>
              {answered.comment&&<p className="question-saved-comment">تعليقك: {answered.comment}</p>}
            </>:canAnswer&&question.active?<>
              <details className="question-comment">
                <summary>إضافة تعليق (اختياري)</summary>
                <textarea rows={2} maxLength={2000} aria-label="تعليق على الإجابة"
                  disabled={isSending} value={comments[question.id]??""}
                  onChange={e=>setComments(prev=>({...prev,[question.id]:e.target.value}))}/>
              </details>
              <p className="question-info-note" role="status">
                {isSending?"جارٍ تسجيل الإجابة…":pendingAnswers[question.id]?"تعذر التسجيل؛ اضغط على الاختيار مرة أخرى للمحاولة.":"اضغط على الإجابة لتسجيلها مباشرة."}
              </p>
            </>:null}
          </div>
        </article>;
      })}
      {tab==="answers"&&responses.map(answer=><article key={answer.id} className="card" style={{marginBlock:"0.75rem",padding:"0.8rem"}}>
        <div><strong>{answer.question}</strong></div>
        <p>{answer.userName} · {date(answer.answeredAt)} · السؤال #{answer.questionId}</p>
        <p className={`question-result ${answer.correct?"question-result-correct":"question-result-wrong"}`}>
          <strong>{answer.correct?"✓ إجابة صحيحة":"✗ إجابة خاطئة"}</strong>
          <span>اختيار: {answer.selectedText}</span>
          {answer.points>0&&<span>+{answer.points} نقطة</span>}
        </p>
        {answer.comment&&<p style={{whiteSpace:"pre-wrap"}}>التعليق: {answer.comment}</p>}
      </article>)}
      {list.data?.items.length===0&&<Notice>{statusFilter==="archived"&&tab==="questions"?"لا توجد أسئلة مؤرشفة في هذه الفئة.":"لا توجد سجلات مطابقة."}</Notice>}
      {!!list.data&&<div className="page-actions question-pagination">
        <span>إجمالي {list.data.total} · تُعرض 20 نتيجة في كل مرة</span>
        <Button variant="primary" disabled={list.isFetching} onClick={refreshQuestions}>
          {list.isFetching?"جارٍ التحديث…":"تحديث"}
        </Button>
      </div>}
    </section>}
  </div>;
}
