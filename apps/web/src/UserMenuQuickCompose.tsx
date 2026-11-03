import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog } from "./ui";
import { useSession } from "./api";
import { queueQuickMessageDelivery, type QuickMessagePayload } from "./QuickMessageDelivery";

export type QuickMessageKind =
  | "system_change" | "present_employees" | "all_employees"
  | "app_manager" | "private_note";

export const quickMessageOptions: readonly {kind:QuickMessageKind;label:string;company:boolean}[]=[
  {kind:"system_change",label:"إضافة طلب تعديل النظام",company:true},
  {kind:"present_employees",label:"رسالة لجميع المحضّرين",company:true},
  {kind:"all_employees",label:"رسالة لجميع الموظفين",company:true},
  {kind:"app_manager",label:"رسالة إلى مسؤول التطبيق",company:false},
  {kind:"private_note",label:"مذكرة خاصة بي",company:false},
];

export function UserMenuQuickCompose({
  kind,companyId,onClose,
}:{
  kind:QuickMessageKind;companyId:number|null;onClose:()=>void;
}) {
  const current=quickMessageOptions.find(option=>option.kind===kind)!;
  const privateNote=kind==="private_note";
  const queryClient=useQueryClient();
  const { user } = useSession();
  const [body,setBody]=useState("");
  // Retain exact payload/UUID when reply is uncertain: retry must not duplicate.
  const frozen=useRef<QuickMessagePayload|null>(null);
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(frozen.current||!body.trim()||!user)return;
    if(current.company&&!companyId)return;
    const payload=frozen.current??{
      kind,...(current.company&&companyId?{companyId}:{}),
      // Retain the database title field internally for future use.
      ...(privateNote?{title:"ملاحظة خاصة"}:{}),
      text:body.trim(),clientRequestId:crypto.randomUUID(),
    };
    frozen.current=payload;
    // Dispatch is owned by the workspace, not this modal. Close synchronously
    // while keeping the exact request UUID for a safe retry on network failure.
    queueQuickMessageDelivery(payload,user.id,queryClient);
    onClose();
  }
  return <Dialog open onClose={onClose} title={current.label}>
    <form className="form-stack" onSubmit={submit}>
      {kind==="present_employees"&&<p className="muted">تصل الرسالة بإشعار إلى الموظفين المحضّرين حاليًا والذين لم يسجّلوا انصرافهم.</p>}
      {kind==="all_employees"&&<p className="muted">تصل الرسالة بإشعار لكل موظف فعّال في الشركة، عدا حسابك.</p>}
      {(kind==="system_change"||kind==="app_manager")&&<p className="muted">يظهر نص الرسالة واسمك للإدارة في قسم التنبيهات، دون دردشة.</p>}
      {privateNote&&<p className="muted">مذكرة لا يراها أحد غيرك، ولا يذهب عنها إشعار لأي مستخدم.</p>}
      <label className="field">
        <span>{privateNote?"الملاحظة":"نص الرسالة"}</span>
        <textarea className="memo-textarea" rows={6} maxLength={3500} required
          value={body} onChange={e=>setBody(e.target.value)}
          placeholder={privateNote?"اكتب ملاحظتك هنا":"اكتب رسالتك هنا"}/>
      </label>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onClose}>إلغاء</Button>
        <Button type="submit" disabled={!body.trim()}>
          {privateNote?"حفظ خاص":"إرسال مع إشعار"}
        </Button>
      </div>
    </form>
  </Dialog>;
}
