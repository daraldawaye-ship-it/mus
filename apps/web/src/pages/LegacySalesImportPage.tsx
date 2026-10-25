import { useState } from "react";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";

type Batch = { idempotencyKey: string; sourceSystem: string; postingDate: string; documents: Array<{type:string;sourceId:string;payload:{kind:string;documentDate:string;lines:unknown[]}}> };
type Result = { imported?:Array<{total?:string}>; existing?:unknown[]; failed?:Array<{sourceId?:string;message?:string}>; accepted?:Array<{total?:string}>; skipped?:unknown[] };
export function LegacySalesImportPage({context}:{context:CompanyContext}) {
  const {user}=useSession();
  const [batches,setBatches]=useState<Batch[]>([]);
  const [name,setName]=useState("");
  const [busy,setBusy]=useState(false);
  const [summary,setSummary]=useState({added:0,existing:0,failed:0,total:0,processed:0});
  const [failures,setFailures]=useState<string[]>([]);
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");
  const count=batches.reduce((n,b)=>n+b.documents.length,0);
  async function load(file?:File) {
    if(!file)return;
    setError("");setSummary({added:0,existing:0,failed:0,total:0,processed:0});setFailures([]);setNotice("");setBatches([]);setName(file.name);
    if(file.size>50_000_000){setError("الحد الأقصى لحجم ملف الترحيل 50 ميجابايت.");return;}
    try {
      const compressed=/\.gz$/i.test(file.name);
      const text=compressed
        ? await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text()
        : await file.text();
      if(text.length>150_000_000)throw new Error("الملف بعد فك الضغط أكبر من الحد المسموح.");
      const raw=text.trim().startsWith("[")?JSON.parse(text):text.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
      if(!Array.isArray(raw)||!raw.length)throw new Error("الملف فارغ أو ليس JSON/JSONL.");
      const parsed=raw as Batch[];
      for(const batch of parsed) {
        if(!batch.idempotencyKey||!batch.sourceSystem||!/^\d{4}-\d\d-\d\d$/.test(batch.postingDate)||!Array.isArray(batch.documents)||!batch.documents.length)throw new Error("صيغة الدفعات غير صحيحة.");
        if(batch.documents.some(d=>d.type!=="invoice"||d.payload.kind!=="sale"||d.payload.documentDate!==batch.postingDate))throw new Error("يُسمح بالمبيعات فقط، ويجب أن يطابق تاريخ الدفعة تاريخ الفاتورة الأصلي.");
      }
      setBatches(parsed);
    } catch(e) {setError(e instanceof Error?e.message:"تعذر قراءة الملف.");}
  }
  async function run() {
    if(!user?.owner||busy||!batches.length)return;
    setBusy(true);setError("");setSummary({added:0,existing:0,failed:0,total:0,processed:0});setFailures([]);setNotice("");
    try {
      for(const batch of batches) {
        for(let offset=0;offset<batch.documents.length;offset+=300) {
          const selected=batch.documents.slice(offset,offset+300);
          const body={...batch,documents:selected,idempotencyKey:crypto.randomUUID()};
          const response=await api<Result>(`/companies/${context.company.id}/transaction-import/batch`,{method:"POST",body});
          const added=response.imported??response.accepted??[];
          const existing=response.existing??response.skipped??[];
          const failed=response.failed??[];
          setSummary(prev=>({added:prev.added+added.length,existing:prev.existing+existing.length,failed:prev.failed+failed.length,total:prev.total+added.reduce((n,row)=>n+Number(row.total??0),0),processed:prev.processed+selected.length}));
          if(failed.length)setFailures(prev=>[...prev,...failed.map(row=>`${row.sourceId??"فاتورة"}: ${row.message??"تعذر الترحيل"}`)]);
        }
      }
    } catch(e){setError(e instanceof Error?e.message:"تعذر الترحيل.");}
    finally{setBusy(false);}
  }
  if(!user?.owner)return <Notice tone="error">هذه الصفحة مخصصة لمالك المنصة.</Notice>;
  return <div className="form-stack">
    <PageHeader title="ترحيل مبيعات النظام السابق" description="صلاحية المالك فقط — التاريخ الأصلي محفوظ — يمنع تكرار معرّف المصدر" />
    <Card title="ملف الدفعات">
      <Notice>اختر ملف JSON أو JSONL أو JSONL.GZ المضغوط المستخرج من النظام السابق ثم اضغط ترحيل جميع الفواتير. الملف يُقرأ محليًا داخل المتصفح، ويُرسل فقط محتوى الدفعات عند الترحيل.</Notice>
      <label htmlFor="legacy-invoice-file">اختيار ملف الفواتير من الجهاز (حتى 50 ميجابايت)</label>
      <input id="legacy-invoice-file" type="file" accept=".json,.jsonl,.gz,application/json,application/gzip" disabled={busy} onChange={e=>void load(e.target.files?.[0])} style={{width:"100%"}}/>
      {name&&<p>الملف: {name} — الفواتير: {count}</p>}
      {batches.length>0&&<><p>أول فاتورة: {batches[0].documents[0].sourceId} — التاريخ: {batches[0].postingDate}</p>
        <Button disabled={busy} onClick={()=>void run()}>{busy?"جارٍ الترحيل…":`ترحيل جميع الفواتير (${count})`}</Button></>}
      {error&&<Notice tone="error">{error}</Notice>}
      {notice&&<Notice tone="success">{notice}</Notice>}
      {summary.processed>0&&<div className="details-list"><strong>نتيجة الترحيل</strong><div>تمت المعالجة: {summary.processed} — أضيف: {summary.added} — موجود مسبقًا: {summary.existing} — مرفوض: {summary.failed}</div><div>إجمالي الفواتير الجديدة: {summary.total.toLocaleString("ar-YE")} ريال</div></div>}
      {failures.length>0&&<details><summary>عرض أسباب الرفض ({failures.length})</summary><ul>{failures.map((failure,i)=><li key={i}>{failure}</li>)}</ul></details>}
    </Card>
  </div>;
}
