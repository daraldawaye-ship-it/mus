import { useState } from "react";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";

type Batch = { idempotencyKey: string; sourceSystem: string; postingDate: string; documents: Array<{type:string;sourceId:string;payload:{kind:string;documentDate:string;lines:unknown[]}}> };
type ImportedDocument = {type:"invoice"|"voucher";sourceId:string;total?:string};
type Result = { imported?:ImportedDocument[]; existing?:ImportedDocument[]; failed?:Array<{type:"invoice"|"voucher";sourceId:string;message?:string}>; accepted?:ImportedDocument[]; skipped?:ImportedDocument[] };
type StageStatus = {pending:number;completed:number;failed:number;total:number};
export function LegacySalesImportPage({context}:{context:CompanyContext}) {
  const {user}=useSession();
  const [batches,setBatches]=useState<Batch[]>([]);
  const [name,setName]=useState("");
  const [busy,setBusy]=useState(false);
  const [summary,setSummary]=useState({added:0,existing:0,failed:0,total:0,processed:0});
  const [failures,setFailures]=useState<string[]>([]);
  const [notice,setNotice]=useState("");
  const [phase,setPhase]=useState<"stage"|"post"|"finalize">("post");
  const [stageStatus,setStageStatus]=useState<StageStatus|null>(null);
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
        if(batch.documents.some(d=>!["invoice","voucher"].includes(d.type)||d.payload.documentDate!==batch.postingDate))throw new Error("نوع المستند أو التاريخ غير صحيح.");
      }
      setBatches(parsed);
    } catch(e) {setError(e instanceof Error?e.message:"تعذر قراءة الملف.");}
  }
  function groupedBatches():Batch[] {
    const result:Batch[]=[];
    for(const batch of batches)for(const document of batch.documents){
      const last=result[result.length-1];
      if(!last||last.postingDate!==batch.postingDate||last.sourceSystem!==batch.sourceSystem||last.documents.length>=300){
        result.push({...batch,idempotencyKey:crypto.randomUUID(),documents:[document]});
      }else last.documents.push(document);
    }
    return result;
  }
  async function refreshStageStatus() {
    const state=await api<StageStatus>(`/companies/${context.company.id}/transaction-import/stage-status`);
    setStageStatus(state);
    return state;
  }
  async function run(stage=false) {
    if(!user?.owner||busy||!batches.length)return;
    setBusy(true);setPhase(stage?"stage":"post");setError("");setSummary({added:0,existing:0,failed:0,total:0,processed:0});setFailures([]);setNotice("");
    try {
      for(const batch of groupedBatches()){
        if(stage){
          const response=await api<{staged:number;alreadyStaged:number;alreadyPosted:number}>(`/companies/${context.company.id}/transaction-import/stage`,{method:"POST",body:batch});
          setSummary(prev=>({...prev,added:prev.added+response.staged,existing:prev.existing+response.alreadyStaged+response.alreadyPosted,processed:prev.processed+batch.documents.length}));
        }else{
          const response=await api<Result>(`/companies/${context.company.id}/transaction-import/batch`,{method:"POST",body:batch});
          const added=response.imported??response.accepted??[];
          const existing=response.existing??response.skipped??[];
          const failed=response.failed??[];
          setSummary(prev=>({added:prev.added+added.length,existing:prev.existing+existing.length,failed:prev.failed+failed.length,total:prev.total+added.reduce((n,row)=>n+Number(row.total??0),0),processed:prev.processed+batch.documents.length}));
          if(failed.length)setFailures(prev=>[...prev,...failed.map(row=>`${row.sourceId??"فاتورة"}: ${row.message??"تعذر الترحيل"}`)]);
        }
      }
      setNotice(stage?"انتهى الحفظ الأولي. لم تُحدّث أرصدة المخزون أو الحسابات؛ تُطبّق بعد انتهاء نقل الملفات.":"انتهى ترحيل الملف، راجع النتائج والأخطاء.");
      if(stage)await refreshStageStatus();
    }catch(e){setError(e instanceof Error?e.message:"تعذر الترحيل.");}
    finally{setBusy(false);}
  }
  async function finalizeStaged() {
    if(!user?.owner||busy)return;
    setBusy(true);setPhase("finalize");setError("");setNotice("");setSummary({added:0,existing:0,failed:0,total:0,processed:0});setFailures([]);
    try{
      while(true){
        const next=await api<{batch:Batch|null}>(`/companies/${context.company.id}/transaction-import/stage-next`);
        if(!next.batch)break;
        const batch=next.batch;
        const result=await api<Result>(`/companies/${context.company.id}/transaction-import/batch`,{method:"POST",body:batch});
        const added=result.imported??result.accepted??[];
        const existing=result.existing??result.skipped??[];
        const failed=result.failed??[];
        await api(`/companies/${context.company.id}/transaction-import/stage-ack`,{method:"POST",body:{
          sourceSystem:batch.sourceSystem,
          completed:[...added,...existing].map(row=>({type:row.type,sourceId:row.sourceId})),
          failed:failed.map(row=>({type:row.type,sourceId:row.sourceId,message:row.message??"تعذر تطبيق المستند"})),
        }});
        setSummary(prev=>({added:prev.added+added.length,existing:prev.existing+existing.length,failed:prev.failed+failed.length,total:prev.total+added.reduce((n,row)=>n+Number(row.total??0),0),processed:prev.processed+batch.documents.length}));
        if(failed.length)setFailures(prev=>[...prev,...failed.map(row=>`${row.sourceId}: ${row.message??"تعذر تطبيق المستند"}`)]);
      }
      const state=await refreshStageStatus();
      setNotice(state.failed>0?`اكتملت معالجة المستندات المتاحة، وبقي ${state.failed} مستندًا مرفوضًا يحتاج إلى إصلاح قبل إعادة المحاولة.`:"اكتملت معالجة المستندات المحفوظة أوليًا. راجع تطابق الحسابات والمخزون.");
    }catch(e){setError(e instanceof Error?e.message:"تعذر إتمام الترحيل النهائي.");}
    finally{setBusy(false);}
  }
  async function retryFailed() {
    if(busy||!user?.owner)return;
    try{
      await api(`/companies/${context.company.id}/transaction-import/stage-retry-failed`,{method:"POST",body:{}});
      await refreshStageStatus();
      setNotice("أُعيدت المستندات المرفوضة إلى قائمة المعالجة النهائية.");
    }catch(e){setError(e instanceof Error?e.message:"تعذر إعادة المحاولة.");}
  }
  if(!user?.owner)return <Notice tone="error">هذه الصفحة مخصصة لمالك المنصة.</Notice>;
  return <div className="form-stack">
    <PageHeader title="ترحيل بيانات النظام السابق" description="صلاحية المالك فقط — حفظ أولي سريع ثم ترحيل حسابي لاحق — منع تكرار معرّف المصدر" />
    <Card title="ملف الدفعات">
      <Notice>اختر ملف JSON أو JSONL أو JSONL.GZ. «الحفظ الأولي السريع» يسجل المستندات دون تغيير المخزون أو الحسابات أو إنشاء إشعارات، وتُنفّذ المعالجة المحاسبية لاحقًا. الملف يُقرأ محليًا في المتصفح.</Notice>
      <label htmlFor="legacy-invoice-file">اختيار ملف الفواتير من الجهاز (حتى 50 ميجابايت)</label>
      <input id="legacy-invoice-file" type="file" accept=".json,.jsonl,.gz,application/json,application/gzip" disabled={busy} onChange={e=>void load(e.target.files?.[0])} style={{width:"100%"}}/>
      {name&&<p>الملف: {name} — الفواتير: {count}</p>}
      {batches.length>0&&<><p>أول فاتورة: {batches[0].documents[0].sourceId} — التاريخ: {batches[0].postingDate}</p>
        <Button disabled={busy} onClick={()=>void run(true)}>{busy?"جارٍ العمل…":`حفظ أولي سريع دون تحديث الحسابات والمخزون (${count})`}</Button>
        <Button disabled={busy} onClick={()=>void run(false)}>{busy?"جارٍ العمل…":`ترحيل محاسبي فوري — أبطأ (${count})`}</Button></>}
      {error&&<Notice tone="error">{error}</Notice>}
      {notice&&<Notice tone="success">{notice}</Notice>}
      {summary.processed>0&&<div className="details-list"><strong>{phase==="stage"?"نتيجة الحفظ الأولي":phase==="finalize"?"نتيجة المعالجة النهائية":"نتيجة الترحيل"}</strong><div>تمت المعالجة: {summary.processed} — {phase==="stage"?"حُفظ أوليًا":"أُضيف"}: {summary.added} — موجود مسبقًا: {summary.existing} — مرفوض: {summary.failed}</div>{phase!=="stage"&&<div>إجمالي المستندات الجديدة: {summary.total.toLocaleString("ar-YE")} ريال</div>}</div>}
      {failures.length>0&&<details><summary>عرض أسباب الرفض ({failures.length})</summary><ul>{failures.map((failure,i)=><li key={i}>{failure}</li>)}</ul></details>}
    </Card>
    <Card title="المعالجة النهائية بعد إكمال نقل جميع الملفات">
      <Notice>المستند المحفوظ أوليًا ليس فاتورة مرحلة محاسبيًا. لا تبدأ المعالجة النهائية حتى تنتهي من نقل المبيعات والمشتريات والسندات، ويُفضّل التحقق من اكتمال ملفاتها. ستحتاج هذه المعالجة إلى وقت لأنها تُنشئ حركات المخزون والقيود المحاسبية بالتسلسل.</Notice>
      <Button disabled={busy} onClick={()=>void refreshStageStatus()}>عرض حالة الملفات المحفوظة أوليًا</Button>
      {stageStatus&&<p>بانتظار المعالجة: {stageStatus.pending} — مكتمل: {stageStatus.completed} — مرفوض: {stageStatus.failed} — الإجمالي: {stageStatus.total}</p>}
      <Button disabled={busy} onClick={()=>void finalizeStaged()}>بدء التسوية المحاسبية والمخزنية للمستندات المحفوظة</Button>
      {stageStatus?.failed? <Button disabled={busy} onClick={()=>void retryFailed()}>إعادة إدراج المستندات المرفوضة بعد إصلاح السبب</Button>:null}
    </Card>
  </div>;
}
