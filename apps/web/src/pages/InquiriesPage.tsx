import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { employeePositions } from "../../../../packages/contracts/src/employee-positions.ts";
import { api, useSession } from "../api";
import { Button, Card, Field, Notice, PageHeader } from "../ui";
import "./InquiriesPage.css";

type Inquiry = {
 id:number;companyId:number|null;companyName:string|null;requestType:string;requestText:string;
 answerType:string;answerOptions:string[];responseMode:"first"|"all";
 recipientSelection:{userIds:number[];positionKeys:string[]};
 priority:string;dueAt:string|null;linkedTable:string|null;linkedRecordId:number|null;
 followUpAction:string;actionResult:string;status:string;createdAt:string;answeredAt:string|null;
 creatorName:string;createdBy:number;assignedCount:number;answeredCount:number;myStatus:string|null;
 targets:{userId:number;name:string;status:string;answeredAt:string|null}[];
 answers:{id:number;userId:number;userName:string;answerValue:string;optionNumber:number|null;explanation:string;answeredAt:string}[];
};
type Recipient={id:number;name:string};
const labels:Record<string,string>={
 question:"سؤال",clarification:"استفسار",information:"طلب معلومات",confirmation:"طلب تأكيد",
 execution:"طلب تنفيذ",number:"رقم",number_note:"رقم",date:"تاريخ",
 yesno:"نعم أو لا",choice:"خيارات",text:"نص",first:"إجابة واحدة تكفي",
 all:"إجابة كل المعنيين",normal:"عادي",important:"مهم",urgent:"عاجل",
 open:"بانتظار الرد",answered:"تمت الإجابة",in_progress:"قيد التنفيذ",
 done:"منفذ",closed:"مغلق",pending:"بانتظار الرد",waived:"سقط عن المعني",answered_target:"أجاب"
};
const when=(v:string|null)=>v?new Date(v).toLocaleString("ar-YE",{dateStyle:"short",timeStyle:"short"}):"—";
const fresh=()=>({
 requestType:"question",requestText:"",answerType:"text",answerOptions:["",""],responseMode:"first" as "first"|"all",
 userIds:[] as number[],positionKeys:[] as string[],priority:"normal",dueAt:"",
 linkedTable:"",linkedRecordId:"",followUpAction:""
});
function EnumField({label,value,options,onChange}:{label:string;value:string;options:[string,string][];onChange:(v:string)=>void}) {
 return <label className="field"><span>{label}</span>
   <select value={value} onChange={e=>onChange(e.target.value)} className="input">
     {options.map(([v,l])=><option key={v} value={v}>{l}</option>)}
   </select></label>;
}
const answerText=(type:string,value:string)=>type==="yesno"?(value==="yes"?"نعم":"لا"):value;
type SavedAnswer=Pick<Inquiry["answers"][number],"answerValue"|"explanation">;

function InquiryAnswerText({type,answer}:{type:string;answer:SavedAnswer}) {
 const text=answerText(type,answer.answerValue);
 return <span style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>
   {answer.explanation?`${text}\n${answer.explanation}`:text}
 </span>;
}

function InquiryAnswerCell({record,userId,root,refresh}:{
 record:Inquiry;userId:number;root:string;refresh:()=>Promise<unknown>;
}) {
 const [answerValue,setAnswerValue]=useState("");
 const [optionNumber,setOptionNumber]=useState(1);
 const [saved,setSaved]=useState<SavedAnswer|"reused"|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const posting=useRef(false);
 const replyKey=useRef<string|null>(null);
 const ownAnswer=record.answers.find(a=>a.userId===userId);
 const shown=ownAnswer??saved??(record.myStatus!=="pending"?record.answers.at(-1):undefined);
 const canReply=record.myStatus==="pending"&&!shown;
 async function reply(e:FormEvent){
   e.preventDefault();
   if(!canReply||posting.current)return;
   posting.current=true;setBusy(true);setError("");
   try {
     const draft={
       answerValue:record.answerType==="choice"?record.answerOptions[optionNumber-1]??"":answerValue.trim(),
       explanation:"",
     };
     replyKey.current??=crypto.randomUUID();
     const confirmed=await api<{reused:boolean}>(root+"/"+record.id+"/answers",{method:"POST",body:{
       answerValue:record.answerType==="choice"?"":answerValue,
       optionNumber:record.answerType==="choice"?optionNumber:null,
       idempotencyKey:replyKey.current
     }});
     // Never present a changed retry as the server's saved answer when the
     // first request had actually committed but its response was lost.
     setSaved(confirmed.reused?"reused":draft);
     void refresh();
   }catch(e){setError(e instanceof Error?e.message:"تعذر حفظ الإجابة");}
   finally{posting.current=false;setBusy(false);}
 }
 if(shown==="reused")return <span role="status">حُفظت الإجابة. جارٍ تحديث النص…</span>;
 if(shown)return <div aria-live="polite" style={{overflowWrap:"anywhere"}}>
   <InquiryAnswerText type={record.answerType} answer={shown}/>
 </div>;
 if(!canReply)return <>—</>;
 return <form className="inquiry-answer-form" onSubmit={reply} aria-label={"الإجابة على الاستفسار "+record.id} style={{display:"grid",gap:6}}>
   {(record.answerType==="number"||record.answerType==="number_note")&&
     <Field label="الرقم" type="number" step="any" required disabled={busy}
       value={answerValue} onChange={e=>setAnswerValue(e.target.value)}/>}
   {record.answerType==="date"&&
     <Field label="التاريخ" type="date" required disabled={busy}
       value={answerValue} onChange={e=>setAnswerValue(e.target.value)}/>}
   {record.answerType==="yesno"&&
     <fieldset disabled={busy}><legend>اختر الإجابة</legend>
       {[["yes","نعم"],["no","لا"]].map(([value,label])=>
       <label key={value} style={{marginInlineEnd:10}}>
         <input type="radio" name={"yesno-"+record.id} checked={answerValue===value}
           onChange={()=>setAnswerValue(value)}/> {label}
       </label>)}
     </fieldset>}
   {record.answerType==="choice"&&<fieldset disabled={busy}><legend>اختر إجابة واحدة</legend>
     {record.answerOptions.map((op,i)=><label key={i} style={{display:"block"}}>
       <input type="radio" name={"choice-"+record.id} checked={optionNumber===i+1}
         onChange={()=>setOptionNumber(i+1)}/> {op}
     </label>)}
   </fieldset>}
   {record.answerType==="text"&&
     <textarea required rows={2} aria-label="نص الإجابة" placeholder="اكتب الإجابة"
       disabled={busy} value={answerValue} maxLength={2000} onChange={e=>setAnswerValue(e.target.value)}/>}
   <Button type="submit" size="compact" disabled={busy||(record.answerType==="yesno"&&!answerValue)}>
     {busy?"جارٍ الحفظ…":"إجابة"}
   </Button>
   {error&&<span role="alert" className="muted">{error}</span>}
 </form>;
}

export function InquiriesPage({companyId,manager=false}:{companyId?:number;manager?:boolean}) {
 const {user}=useSession(),client=useQueryClient();
 const root=companyId?'/companies/'+companyId+'/inquiries':"/inquiries";
 const [filter,setFilter]=useState(""),[search,setSearch]=useState("");
 const [creating,setCreating]=useState(false),[draft,setDraft]=useState(fresh);
 const [recipientSearch,setRecipientSearch]=useState("");
 const [selectedId,setSelectedId]=useState<number|null>(null);
 const followUp=useRef<HTMLElement>(null);
 useEffect(()=>{if(selectedId!==null)followUp.current?.focus();},[selectedId]);
 const [actionResult,setActionResult]=useState("");
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[success,setSuccess]=useState("");
 const createKey=useRef(crypto.randomUUID());
 const entries=useQuery({
   queryKey:["inquiries",user?.id,companyId,filter,search],
   queryFn:()=>api<{items:Inquiry[]}>(root+"?status="+encodeURIComponent(filter)+"&q="+encodeURIComponent(search)),
   enabled:!!user,networkMode:"always"
 });
 const people=useQuery({
   queryKey:["inquiry-recipients",user?.id,companyId,recipientSearch],
   queryFn:()=>api<{items:Recipient[]}>(root+"/recipients?q="+encodeURIComponent(recipientSearch)),
   enabled:!!user&&manager&&creating,networkMode:"always"
 });
 const records=entries.data?.items??[],selected=records.find(x=>x.id===selectedId);
 const pending=records.filter(x=>x.myStatus==="pending").length;
 const invalid=(e:unknown)=>setError(e instanceof Error?e.message:"تعذر إكمال الإجراء");
 function update<K extends keyof ReturnType<typeof fresh>>(key:K,value:ReturnType<typeof fresh>[K]){
   setDraft(d=>({...d,[key]:value}));
 }
 function toggleUser(userId:number){
   update("userIds",draft.userIds.includes(userId)?draft.userIds.filter(x=>x!==userId):[...draft.userIds,userId]);
 }
 function addPosition(key:string){
   if(key&&!draft.positionKeys.includes(key))update("positionKeys",[...draft.positionKeys,key]);
 }
 async function create(e:FormEvent){
   e.preventDefault();if(busy)return;setBusy(true);setError("");setSuccess("");
   try{
     const body={...draft,answerOptions:draft.answerType==="choice"?draft.answerOptions.map(x=>x.trim()):[],
       linkedTable:draft.linkedTable.trim()||null,
       linkedRecordId:draft.linkedRecordId?Number(draft.linkedRecordId):null,
       dueAt:draft.dueAt?new Date(draft.dueAt).toISOString():null,
       idempotencyKey:createKey.current};
     const result=await api<{id:number;recipientCount:number}>(root,{method:"POST",body});
     setSuccess("أُنشئ الطلب رقم "+result.id+" لـ "+result.recipientCount+" مستخدمًا");
     setCreating(false);setDraft(fresh());createKey.current=crypto.randomUUID();
     await client.invalidateQueries({queryKey:["inquiries",user?.id,companyId]});
   }catch(e){invalid(e);}finally{setBusy(false);}
 }
 async function changeStatus(record:Inquiry,status:"in_progress"|"done"|"closed"){
   if(busy)return;setBusy(true);setError("");setSuccess("");
   try{
     await api(root+"/"+record.id+"/status",{method:"PATCH",body:{status,actionResult}});
     setSuccess("تم تحديث حالة الطلب رقم "+record.id);
     await client.invalidateQueries({queryKey:["inquiries",user?.id,companyId]});
   }catch(e){invalid(e);}finally{setBusy(false);}
 }
 if(!user)return <Notice tone="warning">يرجى تسجيل الدخول لعرض الاستفسارات.</Notice>;
 return <div className="inquiries-page">
  <PageHeader title="الاستفسارات والطلبات"
    description={"طلبات مرتبطة بالمهام والسجلات؛ لكل موظف رد محفوظ باسمه. طلباتك المعلقة: "+pending}
    actions={manager?<Button onClick={()=>{setCreating(v=>!v);setError("");setSuccess("");}}>+ طلب جديد</Button>:undefined}/>
  {error&&<Notice tone="error">{error}</Notice>}
  {success&&<Notice tone="success">{success}</Notice>}
  {creating&&manager&&<Card title="إنشاء استفسار أو طلب">
    <form onSubmit={create} style={{display:"grid",gap:12}}>
      <div className="form-grid">
        <EnumField label="نوع الطلب" value={draft.requestType}
          options={["question","clarification","information","confirmation","execution"].map(x=>[x,labels[x]]) as [string,string][]}
          onChange={v=>update("requestType",v)}/>
        <EnumField label="شكل الإجابة" value={draft.answerType}
          options={["text","number","date","yesno","choice"].map(x=>[x,labels[x]]) as [string,string][]}
          onChange={v=>update("answerType",v)}/>
        <EnumField label="آلية الرد" value={draft.responseMode}
          options={[["first","يكفي رد شخص واحد"],["all","رد مستقل لكل معني"]]}
          onChange={v=>update("responseMode",v as "first"|"all")}/>
        <EnumField label="الأولوية" value={draft.priority}
          options={["normal","important","urgent"].map(x=>[x,labels[x]]) as [string,string][]}
          onChange={v=>update("priority",v)}/>
      </div>
      <label className="field"><span>الطلب أو الاستفسار</span>
        <textarea required rows={3} maxLength={4000} value={draft.requestText}
          placeholder="اكتب السؤال أو المعلومات المطلوبة" onChange={e=>update("requestText",e.target.value)}/>
      </label>
      {draft.answerType==="choice"&&<div>
        <strong>خيارات الإجابة (خياران إلى أربعة)</strong>
        {draft.answerOptions.map((value,i)=><Field key={i} label={"الخيار "+(i+1)}
          required value={value} onChange={e=>update("answerOptions",draft.answerOptions.map((x,j)=>j===i?e.target.value:x))}/>)}
        <div className="actions">
          <Button variant="secondary" disabled={draft.answerOptions.length>=4}
            onClick={()=>update("answerOptions",[...draft.answerOptions,""])}>+ خيار</Button>
          <Button variant="secondary" disabled={draft.answerOptions.length<=2}
            onClick={()=>update("answerOptions",draft.answerOptions.slice(0,-1))}>حذف الخيار الأخير</Button>
        </div>
      </div>}
      <Card title="المعنيون بالرد">
        <div className="form-grid">
          {companyId&&<div><strong>الصفات</strong>
            <select className="input" value="" onChange={e=>addPosition(e.target.value)}>
              <option value="">إضافة صفة موظف...</option>
              {employeePositions.filter(p=>!draft.positionKeys.includes(p.key)).map(p=>
                <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <div className="actions" style={{flexWrap:"wrap"}}>
              {draft.positionKeys.map(key=><Button key={key} variant="secondary" size="compact"
                onClick={()=>update("positionKeys",draft.positionKeys.filter(x=>x!==key))}>
                {employeePositions.find(p=>p.key===key)?.label??key} ×
              </Button>)}
            </div>
          </div>}
          <div>
            <Field label="بحث عن المستخدم بالاسم" value={recipientSearch}
              onChange={e=>setRecipientSearch(e.target.value)} placeholder="ابحث عن المستخدم"/>
            {people.isLoading&&<span className="muted">جارٍ تحميل المستخدمين…</span>}
            {people.isError&&<Notice tone="error">تعذر تحميل المستخدمين المعنيين.</Notice>}
            <div style={{maxHeight:190,overflow:"auto",border:"1px solid var(--border-color, #9994)",padding:8,borderRadius:8}}>
              {(people.data?.items??[]).map(person=><label key={person.id}
                style={{display:"flex",gap:8,alignItems:"center",padding:"4px"}}>
                <input type="checkbox" checked={draft.userIds.includes(person.id)}
                  onChange={()=>toggleUser(person.id)}/>
                {person.name} (#{person.id})
              </label>)}
            </div>
            <small>المحددون بالأسماء: {draft.userIds.length} · الصفات: {draft.positionKeys.length}. لن يُكرر الموظف صاحب أكثر من صفة.</small>
          </div>
        </div>
      </Card>
      <div className="form-grid">
        <Field label="موعد الإجابة (اختياري)" type="datetime-local" value={draft.dueAt}
          onChange={e=>update("dueAt",e.target.value)}/>
        <Field label="الجدول المرتبط (اختياري)" value={draft.linkedTable}
          onChange={e=>update("linkedTable",e.target.value)}/>
        <Field label="معرف السجل المرتبط" type="number" min={1} value={draft.linkedRecordId}
          onChange={e=>update("linkedRecordId",e.target.value)}/>
      </div>
      <label className="field"><span>الإجراء المطلوب بعد الرد (للمتابعة ولا ينفذ تغييرات حساسة تلقائيًا)</span>
        <textarea rows={2} value={draft.followUpAction} maxLength={4000}
          onChange={e=>update("followUpAction",e.target.value)}/>
      </label>
      <div className="actions">
        <Button type="submit" disabled={busy||(!draft.userIds.length&&!draft.positionKeys.length)}>
          {busy?"جارٍ الحفظ…":"حفظ وتوجيه الطلب"}
        </Button>
        <Button variant="secondary" onClick={()=>setCreating(false)}>إلغاء</Button>
      </div>
    </form>
  </Card>}
  <Card>
    <div className="form-grid">
      <Field label="بحث في الاستفسارات" value={search} onChange={e=>setSearch(e.target.value)}
        placeholder="نص الطلب أو الجدول المرتبط"/>
      <EnumField label="الحالة" value={filter} onChange={setFilter}
        options={[["","الكل"],["mine","بانتظار ردي"],["open","بانتظار الرد"],["answered","تمت الإجابة"],
          ["in_progress","قيد التنفيذ"],["done","منفذ"],["closed","مغلق"]]}/>
    </div>
    {entries.isLoading&&<p>جارٍ تحميل الاستفسارات…</p>}
    {entries.isError&&<Notice tone="error">تعذر قراءة الاستفسارات. {entries.error instanceof Error?entries.error.message:""}</Notice>}
    {!entries.isLoading&&!records.length&&<p className="muted">لا توجد استفسارات مطابقة.</p>}
    <div className="inquiries-list">
      <table className="inquiries-list-table" role="table">
        <thead><tr>
          <th>الطلب</th><th>المعنيون</th><th>عدد الردود</th>
          <th>الإجابة</th><th>الحالة</th><th>التاريخ والوقت</th><th>الإجراء</th>
        </tr></thead>
        <tbody role="rowgroup">{records.map(record=><tr role="row" key={record.id}>
          <td role="cell" className="inquiry-request-cell">{record.requestText}</td>
          <td role="cell" className="inquiry-targets-cell">
            <span className="inquiry-mobile-label" aria-hidden="true">المعنيون: </span>
            {record.targets.length?record.targets.map(target=>target.name).join("، "):
              record.myStatus!==null?<>{user.displayName||user.name}
                {record.assignedCount>1&&<>، +{record.assignedCount-1}</>}</>:
                record.assignedCount>0?String(record.assignedCount):"—"}
          </td>
          <td role="cell"><span className="inquiry-mobile-label" aria-hidden="true">الردود: </span>{record.answeredCount}</td>
          <td role="cell" className="inquiry-answer-cell">
            <InquiryAnswerCell key={root+":"+user.id+":"+record.id} record={record} userId={user.id} root={root}
              refresh={()=>client.invalidateQueries({queryKey:["inquiries",user.id,companyId]})}/>
            {record.answers.length>1&&<details className="inquiry-answer-history">
              <summary>الردود المسجلة ({record.answers.length})</summary>
              <ul>{record.answers.map(answer=><li key={answer.id}>
                <strong>{answer.userName}</strong> · {when(answer.answeredAt)}
                <div><InquiryAnswerText type={record.answerType} answer={answer}/></div>
              </li>)}</ul>
            </details>}
          </td>
          <td role="cell"><span className="inquiry-mobile-label" aria-hidden="true">الحالة: </span>{labels[record.status]??record.status}</td>
          <td role="cell">{when(record.createdAt)}</td>
          <td role="cell">{manager&&(user.owner||record.createdBy===user.id)&&!["done","closed"].includes(record.status)?
            <Button size="compact" variant="secondary" aria-expanded={selectedId===record.id}
              aria-controls={selectedId===record.id?"inquiry-follow-up":undefined} onClick={()=>{
                if(selectedId===record.id)return;
                setSelectedId(record.id);
                setActionResult(record.actionResult);
              }}>متابعة التنفيذ</Button>:"—"}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </Card>
  {selected&&manager&&(user.owner||selected.createdBy===user.id)&&!["done","closed"].includes(selected.status)&&
  <section id="inquiry-follow-up" ref={followUp} tabIndex={-1}><Card title={"متابعة الطلب رقم "+selected.id}>
    <p><strong>{selected.requestText}</strong></p>
    <p>نوع الإجابة: {labels[selected.answerType]??selected.answerType} · الآلية: {labels[selected.responseMode]} · الأولوية: {labels[selected.priority]} · موعد الرد: {when(selected.dueAt)}</p>
    {selected.linkedTable&&<p><strong>الجدول المرتبط:</strong> {selected.linkedTable} #{selected.linkedRecordId??"—"}</p>}
    {selected.followUpAction&&<p><strong>المتابعة المطلوبة:</strong> {selected.followUpAction}</p>}
    {selected.actionResult&&<p><strong>نتيجة التنفيذ:</strong> {selected.actionResult}</p>}
    {manager&&(user.owner||selected.createdBy===user.id)&&selected.targets.length>0&&<div>
      <strong>المعنيون ({selected.answeredCount} من {selected.assignedCount})</strong>
      <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:8}}>
        {selected.targets.map(t=><span key={t.userId} className="button button-secondary button-compact">
          {t.name}: {t.status==="answered"?"أجاب":labels[t.status]??t.status}
        </span>)}
      </div>
    </div>}
    <h3>الردود</h3>
    {selected.answers.length===0?<p className="muted">لم تُسجل إجابة بعد.</p>:
      <div style={{overflowX:"auto"}}><table style={{width:"100%"}}>
        <thead><tr><th>الرد رقم</th><th>المجيب</th><th>الرد</th><th>تاريخ الرد</th></tr></thead>
        <tbody>{selected.answers.map(a=><tr key={a.id}>
          <td>{a.id}</td><td>{a.userName}</td>
          <td><InquiryAnswerText type={selected.answerType} answer={a}/></td>
          <td>{when(a.answeredAt)}</td>
        </tr>)}</tbody>
      </table></div>}
    {manager&&(user.owner||selected.createdBy===user.id)&&!["done","closed"].includes(selected.status)&&<div style={{marginTop:18}}>
      <label className="field"><span>نتيجة المتابعة والتنفيذ</span>
        <textarea rows={2} value={actionResult} maxLength={4000}
          onChange={e=>setActionResult(e.target.value)}/>
      </label>
      <div className="actions">
        {selected.status==="answered"&&<Button disabled={busy}
          onClick={()=>void changeStatus(selected,"in_progress")}>بدء التنفيذ</Button>}
        {(selected.status==="answered"||selected.status==="in_progress")&&<Button disabled={busy}
          onClick={()=>void changeStatus(selected,"done")}>تم التنفيذ</Button>}
        <Button variant="secondary" disabled={busy}
          onClick={()=>void changeStatus(selected,"closed")}>إغلاق الطلب</Button>
        <Button variant="secondary" disabled={busy}
          onClick={()=>setSelectedId(null)}>إغلاق المتابعة</Button>
      </div>
    </div>}
  </Card></section>}

 </div>;
}