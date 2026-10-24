import { useState } from "react";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";

type Batch = { idempotencyKey: string; sourceSystem: string; postingDate: string; documents: Array<{type:string;sourceId:string;payload:{kind:string;documentDate:string;lines:unknown[]}}> };
type Result = { accepted?:unknown[]; skipped?:unknown[]; failed?:unknown[]; results?:unknown[] };
export function LegacySalesImportPage({context}:{context:CompanyContext}) {
  const {user}=useSession();
  const [batches,setBatches]=useState<Batch[]>([]);
  const [name,setName]=useState("");
  const [busy,setBusy]=useState(false);
  const [limit,setLimit]=useState(5);
  const [results,setResults]=useState<string[]>([]);
  const [error,setError]=useState("");
  const count=batches.reduce((n,b)=>n+b.documents.length,0);
  async function load(file?:File) {
    if(!file)return;
    setError("");setResults([]);setBatches([]);setName(file.name);
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
  async function run() {
    if(!user?.owner||busy||!batches.length)return;
    setBusy(true);setError("");setResults([]);
    let done=0;
    try {
      for(const batch of batches) {
        if(done>=limit)break;
        const selected=batch.documents.slice(0,limit-done);
        const body={...batch,documents:selected,idempotencyKey:crypto.randomUUID()};
        const response=await api<Result>(`/companies/${context.company.id}/transaction-import/batch`,{method:"POST",body});
        done+=selected.length;
        setResults(prev=>[...prev,`دفعة ${batch.postingDate}: ${JSON.stringify(response)}`]);
      }
    } catch(e){setError(e instanceof Error?e.message:"تعذر الترحيل.");}
    finally{setBusy(false);}
  }
  if(!user?.owner)return <Notice tone="error">هذه الصفحة مخصصة لمالك المنصة.</Notice>;
  return <div className="form-stack">
    <PageHeader title="ترحيل مبيعات النظام السابق" description="صلاحية المالك فقط — التاريخ الأصلي محفوظ — يمنع تكرار معرّف المصدر" />
    <Card title="ملف الدفعات">
      <Notice>ارفع ملف JSONL أو JSON المجهز من Access. يُستورد إلى {context.company.name} فقط. لا ترفع ملف ACCDB مباشرة؛ يجب استخراج الدفعات أولًا.</Notice>
      <input type="file" accept=".json,.jsonl,application/json" disabled={busy} onChange={e=>void load(e.target.files?.[0])}/>
      {name&&<p>الملف: {name} — الفواتير: {count}</p>}
      {batches.length>0&&<><p>أول فاتورة: {batches[0].documents[0].sourceId} — التاريخ: {batches[0].postingDate}</p>
        <label>عدد الفواتير التجريبية <input type="number" min={1} max={100} value={limit} onChange={e=>setLimit(Math.max(1,Math.min(100,Number(e.target.value)||5)))}/></label>
        <Button disabled={busy} onClick={()=>void run()}>{busy?"جارٍ الترحيل…":`ترحيل ${Math.min(limit,count)} فواتير`}</Button></>}
      {error&&<Notice tone="error">{error}</Notice>}
      {results.map((r,i)=><pre key={i} style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{r}</pre>)}
    </Card>
  </div>;
}
