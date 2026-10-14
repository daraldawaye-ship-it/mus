import {useState,type FormEvent} from "react";
import {useQuery} from "@tanstack/react-query";
import type {MemoDetail,MemoReminderSettings} from "../../../packages/contracts/src/index";
import {api,useScopeGuard,useSession} from "./api";
import {errorMessage} from "./phase2";
import {Button,Card,Field,Notice} from "./ui";
const local=(iso:string)=>new Intl.DateTimeFormat("ar-YE",{timeZone:"Asia/Aden",
 year:"numeric",month:"long",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(iso));
export function MemoFollowupEditor({companyId,memo,onSaved}:{
 companyId:number;memo:MemoDetail;onSaved:(memo:MemoDetail)=>void;
}) {
 const {user}=useSession(),guard=useScopeGuard(`company:${companyId}:memo:${memo.id}:followup`);
 const settings=useQuery({queryKey:["memo-reminder-settings",user?.id,companyId],
  queryFn:({signal})=>api<{settings:MemoReminderSettings}>(`/companies/${companyId}/memos/reminder-settings`,{signal}),enabled:!!user});
 const [editing,setEditing]=useState(false),[date,setDate]=useState(memo.schedule?.localDate??""),
  [clock,setClock]=useState(memo.schedule?.localTime??""),
  [reason,setReason]=useState(memo.schedule?.reason??""),
  [pending,setPending]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const chosen=clock||settings.data?.settings.defaultTime||"09:00";
 const preview=/^\d{4}-\d\d-\d\d$/.test(date)&&/^\d\d:\d\d$/.test(chosen)
  ?new Date(`${date}T${chosen}:00+03:00`):null;
 const future=!!preview&&Number.isFinite(preview.getTime())&&preview.getTime()>Date.now();
 async function submit(event:FormEvent,action:"set"|"cancel"){
  event.preventDefault();if(pending || !memo.canSchedule || (action==="set"&&(!future||!reason.trim())))return;
  setPending(true);setError("");setNotice("");
  try{
    const body=action==="set"
      ?{action,revision:memo.scheduleRevision,localDate:date,localTime:clock||null,
        reason:reason.trim(),repeatInterval:"none"}
      :{action,revision:memo.scheduleRevision,reason:reason.trim()||"عودة للمتابعة"};
    const result=await api<{memo:MemoDetail}>(`/companies/${companyId}/memos/${memo.id}/schedule`,
      {method:"PUT",body,signal:guard.signal});
    if(guard.isCurrent()){onSaved(result.memo);setEditing(false);setNotice("تم حفظ تغيير موعد المتابعة.");}
  }catch(cause){if(guard.isCurrent())setError(errorMessage(cause));}
  finally{if(guard.isCurrent())setPending(false);}
 }
 return <Card title="تأجيل المتابعة والتذكيرات">
  {error&&<Notice tone="error">{error}</Notice>}
  {notice&&<Notice tone="success">{notice}</Notice>}
  {memo.schedule?.active?<p>مؤجلة حتى {local(memo.schedule.dueAt)} — {memo.schedule.reason}</p>:
  <p className="muted">لا يوجد تأجيل فعال.</p>}
  {memo.canSchedule&&!editing&&<div className="memo-action-buttons">
   <Button variant="secondary" onClick={()=>{
    setDate(memo.schedule?.localDate??"");setClock(memo.schedule?.localTime??"");
    setReason(memo.schedule?.reason??"");setEditing(true);
   }}>{memo.schedule?.active?"تغيير موعد التأجيل":"تأجيل المتابعة"}</Button>
   {memo.schedule?.active&&<Button variant="secondary" disabled={pending}
    onClick={e=>void submit(e,"cancel")}>إلغاء التأجيل</Button>}
  </div>}
