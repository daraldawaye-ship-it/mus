import { useRef,useState } from "react";
import type { CompanyContext } from "../../../packages/contracts/src/index";
import { api,useScopeGuard } from "./api";
import { errorMessage } from "./phase2";
import { Button,Dialog,Notice } from "./ui";

type Row={
  legacyId:string;
  compositionName:string|null;
  shelf:string|null;
  defaultSaleUnit:1|2|3|null;
};
type Payload={
  format:"tijara-item-metadata-v1";
  companyHint:string;
  count:number;
  items:Row[];
};
const canonical=(s:string)=>s.normalize("NFKC")
  .replace(/[\s\u0640]/g,"").replace(/[أإآ]/g,"ا").toLowerCase();

export function ItemMetadataUpdateDialog({
  context,onClose,onUpdated,
}:{
  context:CompanyContext;onClose:()=>void;onUpdated:()=>void;
}){
  const companyId=context.company.id;
  const guard=useScopeGuard(`company:${companyId}:items:metadata-update`);
  const [payload,setPayload]=useState<Payload|null>(null);
  const [fileName,setFileName]=useState("");
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [confirmed,setConfirmed]=useState(false);
  const [running,setRunning]=useState(false);
  const [offset,setOffset]=useState(0);
  const [changed,setChanged]=useState(0);
  const [linkedComposition,setLinkedComposition]=useState(0);
  const [linkedShelf,setLinkedShelf]=useState(0);
  const [legacyShelf,setLegacyShelf]=useState(0);
  const [unitChanged,setUnitChanged]=useState(0);
  const pause=useRef(false);
  const validCompany=!!payload&&
    canonical(payload.companyHint)===canonical(context.company.name)&&
    canonical(context.company.name).includes("دارالدواء");
  const finished=!!payload&&offset>=payload.count;
  async function readFile(file:File|undefined){
    if(!file||running)return;
    setError("");setNotice("");setPayload(null);setConfirmed(false);
    setOffset(0);setChanged(0);setLinkedComposition(0);
    setLinkedShelf(0);setLegacyShelf(0);setUnitChanged(0);
    setFileName(file.name);
    if(file.size>15_000_000){setError("الملف أكبر من 15 ميجابايت.");return}
    try{
      const raw:unknown=JSON.parse(await file.text());
      if(!raw||typeof raw!=="object"||Array.isArray(raw))
        throw Error("ملف التحديث غير صالح.");
      const p=raw as Partial<Payload>;
      if(p.format!=="tijara-item-metadata-v1"||
        typeof p.companyHint!=="string"||
        !Array.isArray(p.items)||!p.items.length||
        p.items.length>100000||p.count!==p.items.length)
        throw Error("اختر ملف تحديث بيانات الأصناف المجهز لهذه العملية.");
      const seen=new Set<string>();
      for(const [i,row] of p.items.entries()){
        if(!row||typeof row.legacyId!=="string"||
          !/^[0-9]{1,100}$/.test(row.legacyId)||
          !(row.compositionName===null||
            (typeof row.compositionName==="string"&&row.compositionName.trim().length>0
             &&row.compositionName.length<=240))||
          !(row.shelf===null||(typeof row.shelf==="string"&&row.shelf.length<=100))||
          !(row.defaultSaleUnit===null||[1,2,3].includes(row.defaultSaleUnit)))
          throw Error(`خطأ في بيانات الصنف ${i+1}`);
        if(seen.has(row.legacyId))throw Error(`المعرف ${row.legacyId} مكرر`);
        seen.add(row.legacyId);
      }
      if(canonical(p.companyHint)!==canonical(context.company.name)||
         !canonical(context.company.name).includes("دارالدواء"))
        throw Error("الملف مخصص لصيدلية دار الدواء؛ اختر هذه الشركة قبل التحديث.");
      setPayload(p as Payload);
    }catch(reason){setError(errorMessage(reason))}
  }
  async function run(){
    if(!payload||!validCompany||!confirmed||running||finished)return;
    pause.current=false;setRunning(true);setError("");setNotice("");
    let position=offset,total=changed,c=linkedComposition,s=linkedShelf,
      old=legacyShelf,u=unitChanged;
    try{
      while(position<payload.items.length&&!pause.current){
        const batch=payload.items.slice(position,position+60);
        const result=await api<{
          processed:number;updated:number;unchanged:number;
          linkedComposition:number;linkedShelf:number;
          legacyShelf:number;unitChanged:number;
        }>(`/companies/${companyId}/items/metadata-update-batch`,{
          method:"POST",signal:guard.signal,
          body:{format:payload.format,companyHint:payload.companyHint,items:batch},
        });
        if(!guard.isCurrent())return;
        position+=result.processed;total+=result.updated;
        c+=result.linkedComposition;s+=result.linkedShelf;
        old+=result.legacyShelf;u+=result.unitChanged;
        setOffset(position);setChanged(total);setLinkedComposition(c);
        setLinkedShelf(s);setLegacyShelf(old);setUnitChanged(u);
      }
      if(guard.isCurrent()){
        onUpdated();
        setNotice(position===payload.count?
          `اكتمل التحديث: تم تعديل ${total.toLocaleString("ar-YE")} صنفًا مع حفظ سجل العمليات.`:
          "أُوقف التحديث مؤقتًا، ويمكن الاستكمال دون تكرار التعديلات.");
      }
    }catch(reason){
      if(guard.isCurrent())
        setError(`توقف التحديث عند السجل ${position+1}: ${errorMessage(reason)}. أعد المحاولة لاستكمال العملية دون تكرار ما تم حفظه.`);
    }finally{if(guard.isCurrent())setRunning(false)}
  }
  return <Dialog open title="تحديث التراكيب والرفوف ووحدة البيع للأصناف"
    onClose={()=>{if(!running)onClose()}}>
    <div className="form-stack">
      <Notice>تحديث الأصناف الموجودة فقط بالمعرف القديم في صيدلية دار الدواء. يربط كرت التركيب وكرت الرف عند وجود تطابق مؤكد، ويحفظ الرف غير المعروف كنص دون تخمين، ويغيّر وحدة البيع عند تحديدها فقط. لا يمس الأسعار أو الأرصدة أو قيود الفواتير.</Notice>
      <p><strong>الشركة:</strong> {context.company.name}</p>
      <div className="field">
        <label htmlFor="item-metadata-file">ملف تحديث الأصناف (JSON)</label>
        <input type="file" id="item-metadata-file" accept=".json,application/json"
          disabled={running} onChange={e=>void readFile(e.target.files?.[0])}/>
      </div>
      {fileName&&<small className="muted">الملف: {fileName}</small>}
      {payload&&<div className="details-list">
        <div>السجلات: <strong>{payload.count.toLocaleString("ar-YE")}</strong></div>
        <div>المعالجة: <strong>{offset.toLocaleString("ar-YE")}</strong></div>
        <div>الأصناف المعدّلة: <strong>{changed.toLocaleString("ar-YE")}</strong></div>
        <div>روابط التركيب الجديدة: <strong>{linkedComposition.toLocaleString("ar-YE")}</strong></div>
        <div>روابط الرفوف الجديدة: <strong>{linkedShelf.toLocaleString("ar-YE")}</strong></div>
        <div>رفوف غير معروفة احتُفظ بها كنص: <strong>{legacyShelf.toLocaleString("ar-YE")}</strong></div>
        <div>تغييرات وحدة البيع: <strong>{unitChanged.toLocaleString("ar-YE")}</strong></div>
        <progress max={payload.count} value={offset} style={{width:"100%"}}/>
      </div>}
      {payload&&!finished&&<label className="check-label">
        <input type="checkbox" checked={confirmed} disabled={running}
          onChange={e=>setConfirmed(e.target.checked)}/>
        أؤكد تحديث أصناف شركة «{context.company.name}» وفق الملف المختار.
      </label>}
      {error&&<Notice tone="error">{error}</Notice>}
      {notice&&<Notice tone="success">{notice}</Notice>}
      <div className="form-actions">
        <Button disabled={!payload||!confirmed||running||finished||!validCompany}
          onClick={()=>void run()}>{offset?"استكمال التحديث":"بدء التحديث"}</Button>
        {running&&<Button variant="secondary" onClick={()=>{pause.current=true}}>
          إيقاف مؤقت بعد الدفعة
        </Button>}
        <Button variant="secondary" disabled={running} onClick={onClose}>
          {finished?"إغلاق":"إلغاء"}
        </Button>
      </div>
    </div>
  </Dialog>;
}
