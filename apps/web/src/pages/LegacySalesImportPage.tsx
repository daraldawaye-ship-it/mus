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
  const [url,setUrl]=useState("");
  const [busy,setBusy]=useState(false);
  const [limit,setLimit]=useState(5);
  const [summary,setSummary]=useState({added:0,existing:0,failed:0,total:0,processed:0});
  const [failures,setFailures]=useState<string[]>([]);
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");
  const count=batches.reduce((n,b)=>n+b.documents.length,0);
  async function load(file?:File) {
    if(!file)return;
    setError("");setSummary({added:0,existing:0,failed:0,total:0,processed:0});setFailures([]);setNotice("");setBatches([]);setName(file.name);
    if(file.size>30_000_000){setError("قسّم الملف إلى أجزاء أصغر من 30 ميجابايت.");return;}
    try {
      const text=await file.text();
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
  async function loadPrepared() {
    if(busy)return;
    setBusy(true);setError("");setSummary({added:0,existing:0,failed:0,total:0,processed:0});setFailures([]);setNotice("");
    try {
      const response=await api<{batches:Batch[]}>(`/companies/${context.company.id}/transaction-import/prepared-next-50`);
      setBatches(response.batches);setName("الدفعة الخاصة — 50 فاتورة");
      setLimit(50);setNotice("تم تحميل 50 فاتورة من المصدر الخاص. اضغط ترحيل 50 فاتورة للاعتماد.");
    }catch(e){setError(e instanceof Error?e.message:"الدفعة الخاصة غير متاحة بعد.");}
    finally{setBusy(false);}
  }
  async function loadUrl() {
    if(!url.trim()||busy)return;
    setBusy(true);setError("");setSummary({added:0,existing:0,failed:0,total:0,processed:0});setFailures([]);setNotice("");setBatches([]);
    try {
      const response=await api<{batches:Batch[]}>(`/companies/${context.company.id}/transaction-import/from-url`,{method:"POST",body:{url:url.trim()}});
      setBatches(response.batches);setName("الرابط المحدد");
      setNotice("تمت قراءة الملف والتحقق منه.");
    }catch(e){setError(e instanceof Error?e.message:"تعذر قراءة الرابط.");}
    finally{setBusy(false);}
  }
  async function run() {
    if(!user?.owner||busy||!batches.length)return;
    setBusy(true);setError("");setSummary({added:0,existing:0,failed:0,total:0,processed:0});setFailures([]);setNotice("");
    let done=0;
    try {
      for(const batch of batches) {
        if(done>=limit)break;
        const selected=batch.documents.slice(0,limit-done);
        const body={...batch,documents:selected,idempotencyKey:crypto.randomUUID()};
        const response=await api<Result>(`/companies/${context.company.id}/transaction-import/batch`,{method:"POST",body});
        done+=selected.length;
        const added=response.imported??response.accepted??[];
        const existing=response.existing??response.skipped??[];
        const failed=response.failed??[];
        setSummary(prev=>({added:prev.added+added.length,existing:prev.existing+existing.length,failed:prev.failed+failed.length,total:prev.total+added.reduce((n,row)=>n+Number(row.total??0),0),processed:prev.processed+selected.length}));
        if(failed.length)setFailures(prev=>[...prev,...failed.map(row=>`${row.sourceId??"فاتورة"}: ${row.message??"تعذر الترحيل"}`)]);
      }
    } catch(e){setError(e instanceof Error?e.message:"تعذر الترحيل.");}
    finally{setBusy(false);}
  }
  if(!user?.owner)return <Notice tone="error">هذه الصفحة مخصصة لمالك المنصة.</Notice>;
  return <div className="form-stack">
    <PageHeader title="ترحيل مبيعات النظام السابق" description="صلاحية المالك فقط — التاريخ الأصلي محفوظ — يمنع تكرار معرّف المصدر" />
    <Card title="ملف الدفعات">
      <Button disabled={busy} onClick={()=>void loadPrepared()}>تحميل الدفعة الخاصة — 50 فاتورة</Button>
      <Notice>ارفع ملف JSONL أو JSON المجهز من Access. يُستورد إلى {context.company.name} فقط. لا ترفع ملف ACCDB مباشرة؛ يجب استخراج الدفعات أولًا.</Notice>
      <label>رابط الملف الآمن (HTTPS)</label>
      <input type="url" dir="ltr" value={url} placeholder="https://..." onChange={e=>setUrl(e.target.value)} disabled={busy} style={{width:"100%"}}/>
      <Button disabled={busy||!url.trim()} onClick={()=>void loadUrl()}>قراءة الملف من الرابط</Button>
      <p>لا يخزن الموقع الملف بعد قراءته؛ تبقى النسخة الأصلية لدى الجهة المستضيفة للرابط.</p>
      <details><summary>أو اختيار ملف من الجهاز</summary>
      <input type="file" accept=".json,.jsonl,application/json" disabled={busy} onChange={e=>void load(e.target.files?.[0])}/></details>
      {name&&<p>الملف: {name} — الفواتير: {count}</p>}
      {batches.length>0&&<><p>أول فاتورة: {batches[0].documents[0].sourceId} — التاريخ: {batches[0].postingDate}</p>
        <label>عدد الفواتير التجريبية <input type="number" min={1} max={100} value={limit} onChange={e=>setLimit(Math.max(1,Math.min(100,Number(e.target.value)||5)))}/></label>
        <Button disabled={busy} onClick={()=>void run()}>{busy?"جارٍ الترحيل…":`ترحيل ${Math.min(limit,count)} فواتير`}</Button></>}
      {error&&<Notice tone="error">{error}</Notice>}
      {notice&&<Notice tone="success">{notice}</Notice>}
      {summary.processed>0&&<div className="details-list"><strong>نتيجة الترحيل</strong><div>تمت المعالجة: {summary.processed} — أضيف: {summary.added} — موجود مسبقًا: {summary.existing} — مرفوض: {summary.failed}</div><div>إجمالي الفواتير الجديدة: {summary.total.toLocaleString("ar-YE")} ريال</div></div>}
      {failures.length>0&&<details><summary>عرض أسباب الرفض ({failures.length})</summary><ul>{failures.map((failure,i)=><li key={i}>{failure}</li>)}</ul></details>}
    </Card>
  </div>;
}
