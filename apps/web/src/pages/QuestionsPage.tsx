import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Info } from "lucide-react";
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
type AnswerOutcome = {
  selectedAnswer:number;correct:boolean;correctAnswer:number|null;
  points:number;firstAttempt?:boolean;comment:string|null;otherOptionCounts:number[];
};
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
  const questionId=params.get("questionId");
  const [infoId,setInfoId]=useState<number|null>(null);
  const infoWrap=useRef<HTMLDivElement|null>(null);
  const optionOrders=useRef<Map<number,number[]>>(new Map());
  const [chosenAnswers,setChosenAnswers]=useState<Record<number,number>>({});
  const [comments,setComments]=useState<Record<number,string>>({});
  const [pendingAnswers,setPendingAnswers]=useState<Record<number,Submission>>({});
  const [savedAnswers,setSavedAnswers]=useState<Record<number,AnswerOutcome>>({});
  const [frozenQuestions,setFrozenQuestions]=useState<{url:string;items:Question[]}|null>(null);
  const [sendingQuestionId,setSendingQuestionId]=useState<number|null>(null);
  const sendingQuestionRef=useRef<number|null>(null);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [editing,setEditing]=useState<Question|null>(null);
  const [saving,setSaving]=useState(false);
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
    if(tab==="answers"&&questionId)search.set("questionId",questionId);
    return `${tab==="questions"?root:answersRoot}?${search}`;
  },[page,query,root,answersRoot,tab,questionId,selectedCategory]);
  const list=useQuery({
    queryKey:["questions-module",user?.id,scope,tab,url],
    queryFn:({signal})=>api<Page<Question> | Page<Answer>>(url,{signal}),
    enabled:!!user && !!visible?.enabled && !!visible.actionAccess.view &&
      (tab==="answers" || categorySelected),
  });
  const liveQuestions=tab==="questions"?(list.data?.items??[]) as Question[]:[];
  // Retain current-page order even if focus-triggered/background refetch sorts answered
  // questions to a later page. New page/search navigation uses live server ordering.
  const questions=frozenQuestions?.url===url
    ? frozenQuestions.items.map(old=>liveQuestions.find(item=>item.id===old.id)??old)
    : liveQuestions;
  const responses=tab==="answers"?(list.data?.items??[]) as Answer[]:[];
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
    setPage(1);setQuery("");setInfoId(null);
    setPendingAnswers({});setFrozenQuestions(null);setError("");setMessage("");
    setParams(current=>{
      const next=new URLSearchParams(current);
      if(category===null)next.delete("category");
      else next.set("category",category);
      next.delete("q");
      return next;
    });
  }
  function outcomeFor(question:Question): AnswerOutcome|null {
    if (savedAnswers[question.id]) return savedAnswers[question.id]!;
    if (question.myLastSelectedAnswer===null || question.myLastCorrect===null) return null;
    return {
      selectedAnswer:question.myLastSelectedAnswer,correct:question.myLastCorrect,
      correctAnswer:question.correctAnswer,points:question.myLastPoints??0,
      comment:question.myLastComment,otherOptionCounts:question.otherOptionCounts??[],
    };
  }
  async function submitAnswer(question:Question,selectedAnswer:number) {
    // The click is the submission: capture the choice directly, without waiting
    // for React's state update or a separate confirmation button.
    if(sendingQuestionRef.current!==null||!canAnswer||outcomeFor(question)||!question.active)return;
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
      setSavedAnswers(prev=>({...prev,[question.id]:{
        ...result,selectedAnswer:payload.selectedAnswer,comment:payload.comment
      }}));
      setPendingAnswers(prev=>{const next={...prev};delete next[question.id];return next;});
      setFrozenQuestions({url,items:questions});
      void client.invalidateQueries({queryKey:["questions-module",user?.id,scope]});
    }catch(cause){setError(errorMessage(cause));}
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
  async function saveQuestion(event:FormEvent){
    event.preventDefault();
    if(!draft||saving)return;
    if(!draft.question.trim()||draft.options.some(v=>!v.trim())){setError("أدخل السؤال وجميع الخيارات الظاهرة");return;}
    setSaving(true);setError("");setMessage("");
    try{
      await api(editing?`${root}/${editing.id}`:root,{
        method:editing?"PUT":"POST",body:editing?{...draft,revision:editing.revision}:draft,
      });
      const savedCategory=draft.category.trim();
      setDraft(null);setEditing(null);
      selectCategory(savedCategory);
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
    {(tab==="answers"||categorySelected)&&<section className="question-results">
      <div className="question-search">
        <Field className="question-search-field" type="search" label="بحث" value={query}
          onChange={e=>{setQuery(e.target.value);setPage(1);setFrozenQuestions(null);}} />
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
                {canEdit&&<Button variant="secondary" size="compact" onClick={()=>startEdit(question)}>تعديل الكرت</Button>}
              </div>}
            </div>
          </div>
          {answered&&<p className="question-result" role="status">
            <strong>{answered.correct?"✓ إجابة صحيحة":"✗ إجابة غير صحيحة"}</strong>
            {answered.points>0?` · +${answered.points} نقطة`:""}
          </p>}
          <div className="question-answer-form">
            <fieldset className="question-options" disabled={!!answered||!canAnswer||!question.active||isSending}>
              <legend className="sr-only">اختر إجابة السؤال</legend>
              {optionOrder(question).map(i=><label key={i}
                className={`question-choice${answered?.selectedAnswer===i+1?" question-choice-selected":""}${answered?.correctAnswer===i+1?" question-choice-correct":""}`}>
                <input type="radio" name={`question-choice-${question.id}`}
                  checked={(answered?.selectedAnswer??chosenAnswers[question.id])===i+1}
                  onChange={()=>void submitAnswer(question,i+1)}
                  onClick={()=>void submitAnswer(question,i+1)}/>
                <span className="question-choice-content">
                  <span>{question.options[i]}</span>
                  {answered&&<span className="question-choice-stat">
                    {answered.otherOptionCounts[i]??0} من الآخرين
                    {answered.selectedAnswer===i+1?" · اختيارك":""}
                    {answered.correctAnswer===i+1?" · ✓ الصحيح":""}
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
        <p>الجواب {answer.selectedAnswer}: {answer.selectedText} · {answer.correct?"صحيح":"غير صحيح"} · {answer.points} نقطة</p>
        {answer.comment&&<p style={{whiteSpace:"pre-wrap"}}>التعليق: {answer.comment}</p>}
      </article>)}
      {list.data?.items.length===0&&<Notice>لا توجد سجلات مطابقة.</Notice>}
      {!!list.data&&<div className="page-actions">
        <span>العدد: {list.data.total} · صفحة {page}</span>
        <Button variant="secondary" size="compact" disabled={page<=1} onClick={()=>setPage(v=>v-1)}>السابق</Button>
        <Button variant="secondary" size="compact" disabled={page*20>=list.data.total} onClick={()=>setPage(v=>v+1)}>التالي</Button>
      </div>}
    </section>}
  </div>;
}
