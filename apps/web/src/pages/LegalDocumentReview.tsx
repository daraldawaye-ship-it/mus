import { useState } from "react";
import { documentPriorities, documentImageLabels, documentPriorityLabels, type LegalDocumentReview, type DocumentImageState, type DocumentPriority } from "../../../../packages/contracts/src/legal-document-review";
import { transcriptionLabels, type TranscriptionState } from "../../../../packages/contracts/src/legal-transcription";
import { Field, Select } from "../ui";

export type ReviewEntry = {
 id:number; title:string; document_review?:LegalDocumentReview; document_image_state?:DocumentImageState|null;
 document_image_id?:number|null; document_case_ids?:number[]|null; transcription_status:TranscriptionState|null;
 drive_file_id:string; pdf_url:string; image_urls:string[];
};

export function DocumentReviewCard({entry}:{entry:ReviewEntry}) {
 const review=entry.document_review;
 const state=entry.document_image_state??"unverified";
 const source=review?.sourceUrl||(entry.drive_file_id?"https://drive.google.com/file/d/"+encodeURIComponent(entry.drive_file_id)+"/view":"")||entry.pdf_url||entry.image_urls?.find(Boolean);
 const filename=review?.sourceFilename??entry.title.match(/(?:^|[\s—–])(\d{4}\.gif)\s*$/i)?.[1];
 return <section className="legal-review-card" aria-label="بطاقة بيانات المستند">
  {review?.documentTitle&&review.documentTitle!==entry.title&&<strong>{review.documentTitle}</strong>}
  <div className="legal-tags">
   <span>الصورة: {documentImageLabels[state]}</span>
   <span>التفريغ: {transcriptionLabels[entry.transcription_status??"unknown"]}</span>
   <span className={review?.priority==="high"?"legal-review-high":undefined}>أهمية النقص: {review?.priority?documentPriorityLabels[review.priority]:entry.transcription_status==="complete"?"لا نقص":"غير مقيّمة"}</span>
   {!!entry.document_case_ids?.length&&<span>القضايا: {entry.document_case_ids.map(id=>"#"+id).join("، ")}</span>}
  </div>
  <div className="legal-doc legal-review-links">
   {entry.document_image_id!=null&&<a href={"/api/legal/images/"+entry.document_image_id} target="_blank" rel="noreferrer">فتح {state==="canonical"?"صورة الأصل":"الصورة"}</a>}
   {source&&<a href={source} target="_blank" rel="noreferrer">فتح المصدر</a>}
   {filename&&<span>الملف: <bdi>{filename}</bdi></span>}
   {review?.sourcePage&&<span>صفحة المصدر: {review.sourcePage}</span>}
  </div>
  {review?.missingPassage&&<p className="legal-preserve"><strong>موضع النقص: </strong>{review.missingPassage}</p>}
  {review?.nextAction&&<p className="legal-preserve"><strong>الخطوة التالية: </strong>{review.nextAction}</p>}
  {!!(review?.evidenceSummary||review?.verifiedOn||review?.keywords?.length||review?.hearingDate||review?.hearingGroup)&&<details>
   <summary>الخلاصة والكلمات المفتاحية</summary>
   {review?.evidenceSummary&&<p className="legal-preserve"><strong>ما يثبته المستند: </strong>{review.evidenceSummary}</p>}
   {!!review?.keywords?.length&&<div className="legal-tags">{review.keywords.map(word=><span key={word}>{word}</span>)}</div>}
   {(review?.hearingDate||review?.hearingGroup)&&<p>الجلسة: <bdi>{review.hearingDate||review.hearingGroup}</bdi></p>}
   {review?.verifiedOn&&<small>آخر تحقق: <bdi>{review.verifiedOn}</bdi></small>}
  </details>}
 </section>;
}

export function groupDocumentRows<T extends ReviewEntry>(items:T[],manual:boolean,selectedCase:number|null) {
 if(!manual)return [{key:"default",label:"",items}];
 const groups=new Map<string,{key:string;label:string;items:T[]}>();
 for(const item of items){
  const review=item.document_review, ids=selectedCase?[selectedCase]:(item.document_case_ids??[]);
  const caseLabel=ids.length?ids.map(id=>"#"+id).join("، "):"دون قضية مرتبطة";
  const hearing=review?.hearingDate||review?.hearingGroup;
  const key=ids.join(",")+(hearing?"|"+hearing:"|record:"+item.id);
  if(!groups.has(key))groups.set(key,{key,label:hearing?`الجلسة: ${hearing} · القضية ${caseLabel}`:`جلسة غير محددة في البطاقة · القضية ${caseLabel}`,items:[]});
  groups.get(key)!.items.push(item);
 }
 return [...groups.values()];
}

export function DocumentReviewFields({value,change,isNew}:{value:LegalDocumentReview;change:(review:LegalDocumentReview)=>void;isNew:boolean}) {
 const set=<K extends keyof LegalDocumentReview>(key:K,x:LegalDocumentReview[K])=>change({...value,[key]:x});
 const [keywordDraft,setKeywordDraft]=useState((value.keywords??[]).join("، "));
 return <details className="legal-review-card legal-wide" open={value.manualTranscription||undefined}>
  <summary>بيانات المستند وأولوية تفريغه</summary>
  <div className="legal-fields">
   <Field label="عنوان المستند كما يظهر في المصدر" value={value.documentTitle??""} maxLength={300} onChange={e=>set("documentTitle",e.target.value||undefined)}/>
   <Field label="اسم ملف المصدر" value={value.sourceFilename??""} maxLength={250} onChange={e=>set("sourceFilename",e.target.value||undefined)}/>
   <Field label="رابط المصدر المؤكد (HTTPS)" value={value.sourceUrl??""} onChange={e=>set("sourceUrl",e.target.value||undefined)}/>
   <Field label="رقم الصفحة في المصدر" type="number" min={1} max={1000000} value={value.sourcePage??""} onChange={e=>set("sourcePage",e.target.value?Number(e.target.value):undefined)}/>
   <Field label="الكلمات المفتاحية (تفصل بفواصل)" value={keywordDraft} onChange={e=>{setKeywordDraft(e.target.value);set("keywords",[...new Set(e.target.value.split(/[،,]/).map(v=>v.trim()).filter(Boolean))]);}}/>
   <Field label="تاريخ الجلسة المؤكد" type="date" value={value.hearingDate??""} onChange={e=>set("hearingDate",e.target.value||undefined)}/>
   <Field label="مجموعة الجلسة (إن ثبت ارتباط أوراقها)" value={value.hearingGroup??""} maxLength={180} onChange={e=>set("hearingGroup",e.target.value||undefined)}/>
   <Field label="تاريخ آخر تحقق" type="date" value={value.verifiedOn??""} onChange={e=>set("verifiedOn",e.target.value||undefined)}/>
   {!isNew&&<Field label="رقم سجل الأصل المرتبط للصورة" type="number" min={1} value={value.canonicalRecordId??""} onChange={e=>set("canonicalRecordId",e.target.value?Number(e.target.value):undefined)}/>}
   <Select label="أهمية النقص" value={value.priority??""} onChange={e=>{const p=e.target.value as DocumentPriority|"";change({...value,priority:p||undefined,manualTranscription:p==="high"?value.manualTranscription:false});}}>
    <option value="">غير مقيّمة</option>{documentPriorities.map(p=><option key={p} value={p}>{documentPriorityLabels[p]}</option>)}
   </Select>
   <label className="legal-review-check"><input type="checkbox" checked={!!value.manualTranscription} disabled={value.priority!=="high"} onChange={e=>set("manualTranscription",e.target.checked)}/> يحتاج تفريغًا يدويًا</label>
   <small className="legal-wide">الأهمية تعني أولوية فهم الجلسة أو القرار أو الخطوة التالية، لا نسبة النص المقروء.</small>
   {([["evidenceSummary","خلاصة ما يثبته المستند"],["missingPassage","موضع النقص المطلوب قراءته"],["nextAction","الخطوة التالية والمسؤول عنها"]] as const).map(([k,label])=><label className="legal-area legal-wide" key={k}><span>{label}</span><textarea rows={2} maxLength={4000} value={value[k]??""} onChange={e=>set(k,e.target.value)}/></label>)}
   {value.manualTranscription&&!value.missingPassage?.trim()&&<small className="legal-wide">حدد الموضع الناقص قبل حفظ طلب التفريغ اليدوي.</small>}
  </div>
 </details>;
}
