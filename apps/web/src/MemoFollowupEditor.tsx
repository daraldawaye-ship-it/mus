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
