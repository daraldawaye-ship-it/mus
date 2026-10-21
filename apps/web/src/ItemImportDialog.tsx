import { useRef, useState } from "react";
import type { CompanyContext } from "../../../packages/contracts/src/index";
import { api, useScopeGuard } from "./api";
import { errorMessage } from "./phase2";
import { Button, Dialog, Notice } from "./ui";

type LegacyItem={
  legacyId:string;name:string;englishName:string;
  unit1Name:string;unit2Name:string;unit3Name:string;
  factor2:number;factor3:number;
  salePrice1:string;salePrice2:string;salePrice3:string;purchasePrice:string;
  hasExpiry:boolean;active:boolean;searchKeys:string;
};
type LegacyPayload={
  format:"tijara-items-v1";
  companyHint:string;
  currency:"YER";
  count:number;
  items:LegacyItem[];
};
const canonical=(label:string)=>label.normalize("NFKC").replace(/[\s\u0640]/g,"").replace(/[أإآ]/g,"ا").toLowerCase();
const matchCompany=(actual:string,hint:string)=>{
  const a=canonical(actual),b=canonical(hint);
  return a===b || (a.includes("دارالدواء")&&b.includes("دارالدواء"));
};
export function ItemImportDialog({
  context,onClose,onImported,
}:{
  context:CompanyContext;
  onClose:()=>void;
  onImported:()=>void;
}){
  const companyId=context.company.id;
  const guard=useScopeGuard(`company:${companyId}:legacy-import`);
  const [fileName,setFileName]=useState("");
  const [payload,setPayload]=useState<LegacyPayload|null>(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [running,setRunning]=useState(false);
  const [confirmed,setConfirmed]=useState(false);
  const [offset,setOffset]=useState(0);
  const [created,setCreated]=useState(0);
  const [skipped,setSkipped]=useState(0);
  const pause=useRef(false);
  const finished=!!payload && offset>=payload.items.length;
  const sameCompany=!!payload && matchCompany(context.company.name,payload.companyHint);
  async function readFile(file:File|undefined){
    if(running||!file)return;
    setError("");setNotice("");setPayload(null);setFileName(file.name);
    setConfirmed(false);setOffset(0);setCreated(0);setSkipped(0);
    if(file.size>12_000_000){setError("ملف الاستيراد أكبر من 12 ميجابايت.");return;}
    try{
      const result:unknown=JSON.parse(await file.text());
      if(!result||typeof result!=="object"||Array.isArray(result))
        throw new Error("ملف الاستيراد غير صالح.");
      const data=result as Partial<LegacyPayload>;
      if(data.format!=="tijara-items-v1"||data.currency!=="YER"||
        typeof data.companyHint!=="string"||!Array.isArray(data.items)||
        data.count!==data.items.length||!data.items.length||
        data.items.some(row=>!row||typeof row.legacyId!=="string"||typeof row.name!=="string"))
        throw new Error("هذا ليس ملف أصناف الرئيسي المجهز للاستيراد.");
      if(new Set(data.items.map(row=>row.legacyId)).size!==data.items.length)
        throw new Error("المعرف في النظام السابق مكرر داخل الملف.");
      if(!matchCompany(context.company.name,data.companyHint))
        throw new Error(`هذا الملف مخصص لشركة «${data.companyHint}» وليس «${context.company.name}».`);
      setPayload(data as LegacyPayload);
    }catch(cause){setError(errorMessage(cause));}
  }
  async function run(){
    if(!payload||running||!sameCompany||!confirmed||finished)return;
    pause.current=false;setRunning(true);setError("");setNotice("");
    let position=offset,inserted=created,duplicates=skipped;
    try{
      while(position<payload.items.length&&!pause.current){
        const items=payload.items.slice(position,position+80);
        const result=await api<{created:number;skipped:number}>(
          `/companies/${companyId}/items/import-batch`,
          {method:"POST",signal:guard.signal,body:{
            format:payload.format,companyHint:payload.companyHint,
            currency:payload.currency,items,
          }},
        );
        if(!guard.isCurrent())return;
        position+=items.length;
        inserted+=result.created;duplicates+=result.skipped;
        setOffset(position);setCreated(inserted);setSkipped(duplicates);
      }
      if(guard.isCurrent()){
        onImported();
        setNotice(position===payload.items.length
          ?`اكتمل استيراد ${inserted} صنفًا جديدًا، وتجاوز ${duplicates} معرفًا موجودًا.`
          :"تم إيقاف الاستيراد مؤقتًا؛ يمكنك استكماله لاحقًا.");
      }
    }catch(cause){
      if(guard.isCurrent())setError(`توقف الاستيراد عند السجل ${position+1}: ${errorMessage(cause)}. يمكنك إعادة المحاولة دون تكرار السجلات السابقة.`);
    }finally{if(guard.isCurrent())setRunning(false);}
  }
  return <Dialog open title="استيراد الأصناف من النظام السابق" onClose={()=>{if(!running)onClose();}}>
    <div className="form-stack">
      <Notice>اختر ملف JSON الذي تم تجهيزه من Excel. تُضاف الأصناف الجديدة فقط اعتمادًا على «المعرف في النظام السابق»، دون تعديل الأصناف الموجودة. العملة: الريال اليمني.</Notice>
      <p><strong>الشركة المستهدفة:</strong> {context.company.name}</p>
      <div className="field">
        <label htmlFor="item-import-file">ملف استيراد الأصناف</label>
        <input id="item-import-file" type="file" accept=".json,application/json"
          disabled={running} onChange={event=>void readFile(event.target.files?.[0])}/>
      </div>
      {fileName&&<small className="muted">الملف: {fileName}</small>}
      {payload&&<div className="details-list">
        <div>الشركة في الملف: <strong>{payload.companyHint}</strong></div>
        <div>إجمالي الأصناف: <strong>{payload.items.length.toLocaleString("ar-YE")}</strong></div>
        <div>تمت المعالجة: <strong>{offset.toLocaleString("ar-YE")}</strong></div>
        <div>أضيف: <strong>{created.toLocaleString("ar-YE")}</strong> — موجود مسبقًا: <strong>{skipped.toLocaleString("ar-YE")}</strong></div>
        <progress max={payload.items.length} value={offset} style={{width:"100%"}} />
      </div>}
      {payload&&!finished&&<label className="check-label">
        <input type="checkbox" checked={confirmed} disabled={running}
          onChange={e=>setConfirmed(e.target.checked)} />
        أؤكد استيراد هذا الملف إلى شركة «{context.company.name}» بالريال اليمني.
      </label>}
      {error&&<Notice tone="error">{error}</Notice>}
      {notice&&<Notice tone="success">{notice}</Notice>}
      <div className="form-actions">
        <Button onClick={()=>void run()} disabled={!payload||!sameCompany||!confirmed||finished||running}>
          {offset>0?"استكمال الاستيراد":"بدء الاستيراد"}
        </Button>
        {running&&<Button variant="secondary" onClick={()=>{pause.current=true;}}>إيقاف مؤقت بعد الدفعة الحالية</Button>}
        <Button variant="secondary" disabled={running} onClick={onClose}>{finished?"إغلاق":"إلغاء"}</Button>
      </div>
    </div>
  </Dialog>;
}
