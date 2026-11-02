import { useRef, useState, type FormEvent } from "react";
import { Button, Dialog, Notice } from "./ui";
import { api } from "./api";

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

type QuickMessagePayload = {
  kind:QuickMessageKind;
  companyId?:number;
  title?:string;
  text:string;
  clientRequestId:string;
};
type Result={sent?:boolean;saved?:boolean;recipients:number;id?:number};
export function UserMenuQuickCompose({
  kind,companyId,onClose,
}:{
  kind:QuickMessageKind;companyId:number|null;onClose:()=>void;
}) {
  const current=quickMessageOptions.find(option=>option.kind===kind)!;
  const privateNote=kind==="private_note";
  const [title,setTitle]=useState("");
  const [body,setBody]=useState("");
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  const [result,setResult]=useState<Result|null>(null);
  // Retain exact payload/UUID when reply is uncertain: retry must not duplicate.
  const frozen=useRef<QuickMessagePayload|null>(null);
  function close() { if(!pending) onClose(); }
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(pending||result||!body.trim())return;
    if(current.company&&!companyId)return;
    const payload=frozen.current??{
      kind,...(current.company&&companyId?{companyId}:{}),
      ...(privateNote?{title:title.trim()}:{}),
      text:body.trim(),clientRequestId:crypto.randomUUID(),
    };
    if(privateNote&&!payload.title) {setError("اكتب عنوان المذكرة");return;}
    frozen.current=payload;
    setPending(true);setError("");
    try {
      const response=await api<Result>("/quick-messages",{method:"POST",body:payload});
      setResult(response);
    }catch(cause) {
      setError(cause instanceof Error?cause.message:"تعذر الإرسال؛ أعد المحاولة بنفس الطلب");
    }finally {setPending(false);}
  }
  return <Dialog open onClose={close} title={current.label}>
    {result?<div className="form-stack">
      <Notice>{privateNote
        ?"تم حفظ المذكرة الخاصة في حسابك دون مشاركتها أو إرسال إشعارات للآخرين. سيتم إضافة مكان عرضها لاحقًا."
        :"تم إرسال الرسالة والإشعارات إلى "+result.recipients+" من المستلمين."}</Notice>
      <div className="form-actions"><Button onClick={onClose}>إغلاق</Button></div>
    </div>:<form className="form-stack" onSubmit={event=>void submit(event)}>
      {kind==="present_employees"&&<p className="muted">تصل الرسالة بإشعار إلى الموظفين المحضّرين حاليًا والذين لم يسجّلوا انصرافهم.</p>}
      {kind==="all_employees"&&<p className="muted">تصل الرسالة بإشعار لكل موظف فعّال في الشركة، عدا حسابك.</p>}
      {(kind==="system_change"||kind==="app_manager")&&<p className="muted">تُرسل الرسالة وإشعارها إلى إدارة التطبيق عبر الدردشة العامة.</p>}
      {privateNote&&<p className="muted">مذكرة لا يراها أحد غيرك، ولا يذهب عنها إشعار لأي مستخدم.</p>}
      {error&&<Notice tone="error">{error}</Notice>}
      {privateNote&&<label className="field">
        <span>عنوان المذكرة</span>
        <input value={title} maxLength={200} required disabled={pending||!!frozen.current}
          onChange={e=>setTitle(e.target.value)} placeholder="عنوان المذكرة الخاصة"/>
      </label>}
      <label className="field">
        <span>{privateNote?"نص المذكرة":"نص الرسالة"}</span>
        <textarea className="memo-textarea" rows={6} maxLength={3500} required
          value={body} disabled={pending||!!frozen.current} onChange={e=>setBody(e.target.value)}
          placeholder={privateNote?"اكتب مذكرتك هنا":"اكتب رسالتك هنا"}/>
      </label>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={close} disabled={pending}>إلغاء</Button>
        <Button type="submit" disabled={pending||!body.trim()||(privateNote&&!title.trim())}>
          {pending?"جارٍ الحفظ…":frozen.current?"إعادة محاولة نفس الإرسال":privateNote?"حفظ خاص":"إرسال مع إشعار"}
        </Button>
      </div>
    </form>}
  </Dialog>;
}
