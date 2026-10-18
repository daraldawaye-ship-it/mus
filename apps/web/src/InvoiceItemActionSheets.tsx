import { useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  memoCreateSchema,
  type CompanyContext,
  type Item,
  type MemoCreateInput,
  type MemoRecipient,
} from "../../../packages/contracts/src/index.ts";
import { api, ApiFailure, useScopeGuard, useSession } from "./api";
import { errorMessage, ServerLookup } from "./phase2";
import { Button, Field, Notice } from "./ui";
import { InventoryAdjustmentSheet } from "./pages/InventoryPages";

export function InvoiceItemAdjustmentSheet({
  context,itemId,onClose,onSaved,
}: {
  context:CompanyContext;itemId:number;
  onClose:()=>void;
  onSaved:(itemId:number,expiry:string|null)=>void;
}) {
  const {user}=useSession();
  const companyId=context.company.id;
  const item=useQuery({
    queryKey:["invoice-item-adjustment",user?.id,companyId,itemId],
    queryFn:({signal})=>api<{item:Item}>(`/companies/${companyId}/items/${itemId}`,{signal}),
    enabled:!!user&&itemId>0,
  });
  if(item.data?.item) {
    return <InventoryAdjustmentSheet context={context} item={item.data.item}
      onClose={onClose} onSaved={date=>onSaved(itemId,date)}/>;
  }
  return createPortal(
    <>
      <div className="inventory-sheet-backdrop" aria-hidden="true"/>
      <section className="inventory-sheet-panel" role="dialog" aria-modal="true"
        aria-label="تحميل تسوية الصنف">
        <div className="inventory-sheet-header">
          <strong>تسوية الصنف</strong>
          <Button variant="secondary" onClick={onClose}>إغلاق</Button>
        </div>
        {item.isLoading && <p>جارٍ تحميل بيانات الصنف…</p>}
        {item.error && <Notice tone="error">{errorMessage(item.error)}</Notice>}
      </section>
    </>,document.body,
  );
}

export function InvoiceItemReportSheet({
  context,itemId,itemName,onClose,onCreated,
}: {
  context:CompanyContext;itemId:number;itemName:string;
  onClose:()=>void;onCreated:(memoId:number)=>void;
}) {
  const companyId=context.company.id;
  const {user}=useSession();
  const guard=useScopeGuard(`company:${companyId}:invoice-item-report:${itemId}`);
  const queryClient=useQueryClient();
  const [title,setTitle]=useState(`تقرير عن الصنف: ${itemName}`);
  const [body,setBody]=useState("");
  const [recipient,setRecipient]=useState<MemoRecipient|null>(null);
  const [error,setError]=useState("");
  const [saving,setSaving]=useState(false);
  // Keep the exact UUID and payload for retries after uncertain network failures.
  const [submitted,setSubmitted]=useState<MemoCreateInput|null>(null);
  const requestInFlight=useRef(false);
  const locked=saving||!!submitted;
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(requestInFlight.current)return;
    if(!submitted&&!recipient){setError("اختر الموظف المستلم للتقرير");return;}
    const parsed=memoCreateSchema.safeParse(submitted??{
      title,body,type:"review",recipientEmployeeId:recipient!.id,
      links:{followPage:null,referencePage:null,itemId,accountId:null},
      followers:[],options:[],idempotencyKey:crypto.randomUUID(),
    });
    if(!parsed.success){
      setError(parsed.error.issues.map(issue=>issue.message).join(" · "));
      return;
    }
    const frozen=parsed.data;
    setSubmitted(frozen);
    requestInFlight.current=true;
    setSaving(true);setError("");
    try {
      const created=await api<{memo:{id:number}}>(
        `/companies/${companyId}/memos`,
        {method:"POST",body:frozen,signal:guard.signal},
      );
      if(!guard.isCurrent())return;
      await Promise.all([
        queryClient.invalidateQueries({queryKey:["list",user?.id,`company:${companyId}:memos`]}),
        queryClient.invalidateQueries({queryKey:["notifications",user?.id]}),
      ]);
      if(!guard.isCurrent())return;
      onCreated(created.memo.id);
    }catch(cause){
      if(!guard.isCurrent())return;
      setError(errorMessage(cause));
      if(cause instanceof ApiFailure && cause.status>=400 && cause.status<500)
        setSubmitted(null);
    }finally {
      requestInFlight.current=false;
      if(guard.isCurrent())setSaving(false);
    }
  }
  return createPortal(
    <>
      <div className="inventory-sheet-backdrop" aria-hidden="true"/>
      <section className="inventory-sheet-panel invoice-item-report-sheet"
        role="dialog" aria-modal="true" aria-label="إرسال تقرير مرتبط بالصنف">
        <div className="inventory-sheet-header">
          <strong>إرسال تقرير مرتبط بالصنف</strong>
          <Button variant="secondary" disabled={locked} onClick={onClose}>إغلاق</Button>
        </div>
        <form className="form-stack" onSubmit={event=>void submit(event)}>
          <Field label="الصنف" value={itemName} readOnly/>
          <Field label="عنوان التقرير" value={title} maxLength={200}
            disabled={locked} required
            onChange={event=>setTitle(event.target.value)}/>
          <ServerLookup<MemoRecipient>
            companyId={companyId}
            resource={`/companies/${companyId}/memos/recipients`}
            label="إرسال إلى الموظف"
            value={recipient} onChange={setRecipient} display={entry=>entry.name}
            disabled={locked} required
            emptyLabel="اختر المستلم"/>
          <div className="field">
            <label htmlFor={`invoice-item-report-body-${itemId}`}>شرح التقرير</label>
            <textarea id={`invoice-item-report-body-${itemId}`}
              className="memo-textarea"
              value={body} rows={4} maxLength={20000}
              onChange={event=>setBody(event.target.value)}
              disabled={locked} required autoFocus/>
          </div>
          {error&&<Notice tone="error">{error}</Notice>}
          {submitted&&!saving&&<Notice tone="warning">
            لم يتأكد إرسال التقرير. يمكنك إعادة محاولة الطلب نفسه دون إنشاء تقرير مكرر.
          </Notice>}
          <div className="form-actions">
            <Button type="submit" disabled={saving}>
              {saving?"جارٍ الإرسال…":submitted?"إعادة تأكيد الإرسال":"إرسال التقرير"}
            </Button>
            <Button variant="secondary" type="button" disabled={locked} onClick={onClose}>
              إلغاء
            </Button>
          </div>
          <small className="muted">
            يرتبط التقرير تلقائيًا بهذا الصنف ويظهر ضمن المذكرات والمتابعة،
            ولا يُغيّر بيانات الفاتورة.
          </small>
        </form>
      </section>
    </>,document.body,
  );
}
