import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, useSession } from "../api";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";
import { errorMessage } from "../phase2";

type Kind = "fact"|"document"|"event"|"explanation"|"task"|"report"|"hearing";
type Case = {id:number;title:string;case_number:string;agency:string;stage:string;status:string;file_copy_status:string;start_date:string|null;next_hearing:string|null;priority:number;summary:string;needs_review:boolean;legacy_snapshot:unknown;revision:number};
type Entry = {id:number;kind:Kind;title:string;body:string;content_text:string;image_urls:string[];pdf_url:string;drive_file_id:string;drive_folder_id:string;drive_folder_url:string;source_issuer:string;document_number:string;record_date:string|null;due_at:string|null;sort_order:number;status:string;assigned_to:number|null;created_by:number;created_at:string;creator_name?:string;reviewed_at:string|null;revision:number;image_count:number;legacy_snapshot:unknown};
type Person = {id:number;name:string};
type CaseForm = {title:string;caseNumber:string;agency:string;stage:string;status:string;fileCopyStatus:string;startDate:string|null;nextHearing:string|null;priority:number;summary:string};
type RecordForm = {kind:Kind;title:string;body:string;contentText:string;imageUrls:string[];pdfUrl:string;driveFileId:string;driveFolderId:string;driveFolderUrl:string;sourceIssuer:string;documentNumber:string;recordDate:string|null;dueAt:string|null;sortOrder:number;status:string;assignedTo:number|null;caseIds:number[]};
const kinds:{id:Kind;label:string}[]=[{id:"explanation",label:"الشرح"},{id:"fact",label:"المعطيات"},{id:"event",label:"التسلسل الزمني"},{id:"document",label:"المستندات"},{id:"task",label:"المهام"},{id:"report",label:"تقارير المتابعة"},{id:"hearing",label:"الجلسات"}];
const emptyCase:CaseForm={title:"",caseNumber:"",agency:"",stage:"",status:"active",fileCopyStatus:"unknown",startDate:null,nextHearing:null,priority:0,summary:""};
const caseForm=(c:Case):CaseForm=>({title:c.title,caseNumber:c.case_number,agency:c.agency,stage:c.stage,status:c.status,fileCopyStatus:c.file_copy_status,startDate:c.start_date?.slice(0,10)??null,nextHearing:c.next_hearing?.slice(0,10)??null,priority:c.priority,summary:c.summary});
const entryForm=(kind:Kind,caseId:number,e?:Entry):RecordForm=>({kind,title:e?.title??"",body:e?.body??"",contentText:e?.content_text??"",imageUrls:e?.image_urls??[],pdfUrl:e?.pdf_url??"",driveFileId:e?.drive_file_id??"",driveFolderId:e?.drive_folder_id??"",driveFolderUrl:e?.drive_folder_url??"",sourceIssuer:e?.source_issuer??"",documentNumber:e?.document_number??"",recordDate:e?.record_date?.slice(0,10)??null,dueAt:e?.due_at??null,sortOrder:e?.sort_order??0,status:e?.status??(kind==="task"?"pending":""),assignedTo:e?.assigned_to??null,caseIds:caseId?[caseId]:[]});
function TextField({label,value,onChange,rows=3}:{label:string;value:string;onChange:(s:string)=>void;rows?:number}) {return <label className="legal-area"><span>{label}</span><textarea value={value} rows={rows} onChange={e=>onChange(e.target.value)}/></label>;}
function CaseFields({value,change,disabled}:{value:CaseForm;change:(value:CaseForm)=>void;disabled?:boolean}) {
 const set=(key:keyof CaseForm,v:string|number|null)=>change({...value,[key]:v});
 return <div className="legal-fields">
 <Field label="اسم القضية" value={value.title} onChange={e=>set("title",e.target.value)}/>
 <Field label="رقم القضية" value={value.caseNumber} onChange={e=>set("caseNumber",e.target.value)}/>
 <Field label="المحكمة أو الجهة" value={value.agency} onChange={e=>set("agency",e.target.value)}/>
 <Field label="المرحلة القضائية" value={value.stage} onChange={e=>set("stage",e.target.value)}/>
 <Select label="الحالة" disabled={disabled} value={value.status} onChange={e=>set("status",e.target.value)}><option value="active">فعالة</option><option value="closed">منتهية</option><option value="unknown">غير محددة</option></Select>
 <Select label="صورة الملف" value={value.fileCopyStatus} onChange={e=>set("fileCopyStatus",e.target.value)}><option value="unknown">لم تحدد</option><option value="yes">موجودة</option><option value="no">غير موجودة</option><option value="partial">ناقصة</option></Select>
 <Field label="تاريخ بداية القضية" type="date" value={value.startDate??""} onChange={e=>set("startDate",e.target.value||null)}/>
 <Field label="تاريخ الجلسة القادمة" type="date" value={value.nextHearing??""} onChange={e=>set("nextHearing",e.target.value||null)}/>
 <Field label="الأولوية 0–10" type="number" min={0} max={10} value={value.priority} onChange={e=>set("priority",Number(e.target.value))}/>
 <div className="legal-wide"><TextField label="ملخص القضية" value={value.summary} onChange={v=>set("summary",v)}/></div></div>;
}
function EntryFields({value,change,people}:{value:RecordForm;change:(v:RecordForm)=>void;people:Person[]}) {
 const set=(key:keyof RecordForm,v:unknown)=>change({...value,[key]:v});
 return <div className="legal-fields">
 <Field label="العنوان" value={value.title} onChange={e=>set("title",e.target.value)}/>
 <Field label="الترتيب" type="number" min={0} value={value.sortOrder} onChange={e=>set("sortOrder",Number(e.target.value))}/>
 <div className="legal-wide"><TextField label="الشرح التفصيلي" value={value.body} rows={6} onChange={v=>set("body",v)}/></div>
 {(value.kind==="document")&&<>
 <div className="legal-wide"><TextField label="النص الكامل للمستند — مستقل عن الشرح" value={value.contentText} rows={8} onChange={v=>set("contentText",v)}/></div>
 <Field label="رابط PDF في Drive أو الموقع" value={value.pdfUrl} onChange={e=>set("pdfUrl",e.target.value)}/>
 <Field label="معرّف ملف Drive" value={value.driveFileId} onChange={e=>set("driveFileId",e.target.value)}/>
 <Field label="معرّف مجلد Drive" value={value.driveFolderId} onChange={e=>set("driveFolderId",e.target.value)}/>
 <Field label="رابط مجلد Drive" value={value.driveFolderUrl} onChange={e=>set("driveFolderUrl",e.target.value)}/>
 <Field label="الجهة المصدرة" value={value.sourceIssuer} onChange={e=>set("sourceIssuer",e.target.value)}/>
 <Field label="الرقم الرسمي للمستند" value={value.documentNumber} onChange={e=>set("documentNumber",e.target.value)}/>
 <div className="legal-wide"><TextField label="روابط الصور الخارجية (رابط HTTPS في كل سطر)" rows={2} value={value.imageUrls.join("\n")} onChange={v=>set("imageUrls",v.split("\n").map(s=>s.trim()).filter(Boolean))}/></div>
 </>}
 <Field label="تاريخ الواقعة أو المستند" type="date" value={value.recordDate??""} onChange={e=>set("recordDate",e.target.value||null)}/>
 {(value.kind==="task"||value.kind==="hearing")&&<Field label="موعد المتابعة" type="datetime-local" value={value.dueAt?.slice(0,16)??""} onChange={e=>set("dueAt",e.target.value?new Date(e.target.value).toISOString():null)}/>}
 {value.kind==="task"&&<Select label="المكلف" value={value.assignedTo??""} onChange={e=>set("assignedTo",e.target.value?Number(e.target.value):null)}>
 <option value="">غير محدد</option>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select>}
 {value.kind==="task"&&<Select label="الحالة" value={value.status||"pending"} onChange={e=>set("status",e.target.value)}><option value="pending">مطلوبة</option><option value="working">جارٍ العمل</option><option value="submitted">تم الإبلاغ</option><option value="blocked">متعذرة</option><option value="verified">تم التحقق</option></Select>}
 </div>;
}
export function LegalCasesPage() {
 const {user}=useSession(),owner=!!user?.owner,client=useQueryClient(),[params,setParams]=useSearchParams();
 const caseId=Number(params.get("case"))||0,tab=params.get("tab")||"overview";
 const [search,setSearch]=useState(""),[page,setPage]=useState(1),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
 const [caseEdit,setCaseEdit]=useState(false),[caseNew,setCaseNew]=useState(false),[caseDraft,setCaseDraft]=useState<CaseForm>(emptyCase);
 const [entryEdit,setEntryEdit]=useState<number|"new"|null>(null),[entryDraft,setEntryDraft]=useState<RecordForm>(entryForm("fact",0));
 const [focus,setFocus]=useState<number|null>(null),[linkNumber,setLinkNumber]=useState(""),[accessUser,setAccessUser]=useState(""),[accessRole,setAccessRole]=useState("reporter");
 const list=useQuery({queryKey:["legal","cases",search,page],queryFn:()=>api<{items:Case[];total:number}>( "/legal/cases?"+new URLSearchParams({q:search,page:String(page)})),enabled:!!user});
 const selected=useQuery({queryKey:["legal","case",caseId],queryFn:()=>api<{record:Case;role:string}>("/legal/cases/"+caseId),enabled:caseId>0});
 const records=useQuery({queryKey:["legal","records",caseId],queryFn:()=>api<{items:Entry[]}>("/legal/cases/"+caseId+"/records"),enabled:caseId>0});
 const all=useQuery({queryKey:["legal","all",tab],queryFn:()=>api<{items:Entry[]}>("/legal/records"),enabled:owner&&tab==="unlinked"});
 const people=useQuery({queryKey:["legal","people"],queryFn:()=>api<{items:Person[]}>("/legal/people"),enabled:owner});
 const links=useQuery({queryKey:["legal","linked",focus],queryFn:()=>api<{record:Entry;caseIds:number[];linkedIds:number[];images:{id:number;filename:string}[]}>("/legal/records/"+focus),enabled:!!focus});
 const access=useQuery({queryKey:["legal","access",caseId],queryFn:()=>api<{items:{user_id:number;user_name:string;role:string}[]}>("/legal/cases/"+caseId+"/access"),enabled:owner&&caseId>0&&tab==="access"});
 const editor=owner||selected.data?.role==="editor",reporter=editor||selected.data?.role==="reporter";
 const visible=(tab==="unlinked"?(all.data?.items??[]).filter(e=>!records.data?.items.some(r=>r.id===e.id)):(records.data?.items??[]).filter(e=>e.kind===tab));
 const go=(key:string,value:string)=>setParams(p=>{const next=new URLSearchParams(p);next.set(key,value);if(key==="case")next.set("tab","overview");return next;});
 const action=async(fn:()=>Promise<void>)=>{setBusy(true);setError("");setNotice("");try{await fn();await client.invalidateQueries({queryKey:["legal"]});setNotice("حُفظ التغيير");}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
 const submitCase=()=>void action(async()=>{
  if(caseNew){const result=await api<{record:Case}>("/legal/cases",{method:"POST",body:caseDraft});go("case",String(result.record.id));}
  else if(selected.data)await api("/legal/cases/"+caseId,{method:"PUT",body:{...caseDraft,revision:selected.data.record.revision}});
  setCaseEdit(false);setCaseNew(false);
 });
 const beginEntry=(kind:Kind,e?:Entry)=>{setEntryDraft(entryForm(kind,caseId,e));setEntryEdit(e?e.id:"new");setError("");};
 const submitEntry=()=>void action(async()=>{
  if(entryEdit==="new"){const result=await api<{record:Entry}>("/legal/records",{method:"POST",body:entryDraft});setFocus(result.record.id);}
  else if(typeof entryEdit==="number"){
   const old=(records.data?.items??[]).concat(all.data?.items??[]).find(x=>x.id===entryEdit);
   if(!old)throw new Error("تعذر العثور على السجل");
   const {caseIds:_,...payload}=entryDraft;
   await api("/legal/records/"+entryEdit,{method:"PUT",body:{...payload,revision:old.revision}});
  }
  setEntryEdit(null);
 });
 const imageUpload=(entryId:number,file:File|undefined)=>{if(!file)return;if(file.size>2097152){setError("الحد 2 ميجابايت للصورة؛ استخدم Drive للملفات الكبيرة");return;}
  const reader=new FileReader();reader.onload=()=>void action(async()=>{await api("/legal/records/"+entryId+"/images",{method:"POST",body:{filename:file.name,dataUrl:String(reader.result)}});setFocus(entryId);});
  reader.onerror=()=>setError("تعذر قراءة الصورة");reader.readAsDataURL(file);
 };
 return <div className="legal-workspace">
 <PageHeader title="إدارة قضايا مصطفى" description="القضايا والشرح والمعطيات والمستندات والتقارير المرتبطة" actions={owner?<Button onClick={()=>{setCaseNew(true);setCaseEdit(true);setCaseDraft(emptyCase);}}>قضية جديدة</Button>:undefined}/>
 {error&&<Notice tone="error">{error}</Notice>}{notice&&<Notice tone="success">{notice}</Notice>}
 <div className="legal-grid"><Card title="القضايا"><Field label="ابحث" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/>
 <div className="legal-case-list">{(list.data?.items??[]).map(c=><button key={c.id} className={"legal-case-link"+(caseId===c.id?" selected":"")} onClick={()=>{go("case",String(c.id));setCaseEdit(false);setEntryEdit(null);setFocus(null);}}><strong>{c.title}</strong><small>{c.case_number||"دون رقم"} · {c.status==="closed"?"منتهية":c.status==="active"?"فعالة":"غير محددة"} · أولوية {c.priority}</small></button>)}</div>
 {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
 <div className="legal-actions"><Button variant="secondary" disabled={page===1} onClick={()=>setPage(p=>p-1)}>السابق</Button><span>{page} / {Math.max(1,Math.ceil((list.data?.total??0)/30))}</span><Button variant="secondary" disabled={page*30>=(list.data?.total??0)} onClick={()=>setPage(p=>p+1)}>التالي</Button></div>
 <p>عدد القضايا: {list.data?.total??"…"}؛ البيانات القديمة باقية كما هي.</p>
 {owner&&<Button variant="secondary" onClick={()=>go("tab","unlinked")}>سجلات تحتاج ربطًا</Button>}
 </Card>
 <div className="legal-content">
 {caseNew?<Card title="إضافة قضية"><CaseFields value={caseDraft} change={setCaseDraft}/><div className="legal-actions"><Button disabled={busy||!caseDraft.title} onClick={submitCase}>حفظ القضية</Button><Button variant="secondary" onClick={()=>{setCaseNew(false);setCaseEdit(false);}}>إلغاء</Button></div></Card>:
 selected.data?<><Card title={selected.data.record.title}>
 {selected.data.record.needs_review&&<Notice tone="warning">هذا السجل منقول من الجدول العام ويحتاج استكمال بياناته ومراجعتها؛ الأصل محفوظ.</Notice>}
 {caseEdit?<><CaseFields value={caseDraft} change={setCaseDraft} disabled={!owner}/><div className="legal-actions"><Button disabled={busy||!caseDraft.title} onClick={submitCase}>حفظ</Button><Button variant="secondary" onClick={()=>setCaseEdit(false)}>إلغاء</Button></div></>:
 <><div className="legal-tags"><span>{selected.data.record.case_number||"لم يحدد الرقم"}</span><span>{selected.data.record.agency||"لم تحدد الجهة"}</span><span>{selected.data.record.status==="closed"?"منتهية":selected.data.record.status==="active"?"فعالة":"غير محددة"}</span><span>صورة الملف: {({unknown:"غير محددة",yes:"موجودة",no:"غير موجودة",partial:"ناقصة"} as Record<string,string>)[selected.data.record.file_copy_status]??"غير محددة"}</span></div>
 <div className="legal-tags"><span>البداية: {selected.data.record.start_date?.slice(0,10)||"—"}</span><span>الجلسة: {selected.data.record.next_hearing?.slice(0,10)||"—"}</span><span>المرحلة: {selected.data.record.stage||"—"}</span></div><p className="legal-preserve">{selected.data.record.summary}</p>
 {selected.data.record.legacy_snapshot&&<details className="legal-legacy"><summary>البيانات الأصلية المنقولة من الجدول العام</summary><pre>{JSON.stringify(selected.data.record.legacy_snapshot,null,2)}</pre></details>}
 <div className="legal-actions">{editor&&<Button variant="secondary" onClick={()=>{setCaseDraft(caseForm(selected.data!.record));setCaseEdit(true);}}>تعديل بيانات القضية</Button>}
 <Button variant="secondary" onClick={()=>void action(async()=>{const data=await api<unknown>("/legal/cases/"+caseId+"/ai-export");await navigator.clipboard.writeText(JSON.stringify(data,null,2));setNotice("تم نسخ البيانات المترابطة");})}>نسخ ملف القضية للذكاء الاصطناعي</Button></div></>}
 </Card>
 <div className="legal-tabs">{[{id:"overview",label:"نظرة عامة"},...kinds,...(owner?[{id:"access",label:"الصلاحيات"},{id:"unlinked",label:"السجلات القديمة"}]:[])].map(k=><Button key={k.id} variant={tab===k.id?"primary":"secondary"} onClick={()=>{go("tab",k.id);setEntryEdit(null);}}>{k.label}{k.id!=="overview"&&(records.data?.items??[]).filter(r=>r.kind===k.id).length?" ("+(records.data?.items??[]).filter(r=>r.kind===k.id).length+")":""}</Button>)}</div>
 {tab==="overview"?<Card title="محتويات الملف"><div className="legal-overview">{kinds.map(k=><button key={k.id} onClick={()=>go("tab",k.id)}><strong>{k.label}</strong><span>{(records.data?.items??[]).filter(r=>r.kind===k.id).length}</span></button>)}</div></Card>:
 tab==="access"&&owner?<Card title="الصلاحيات"><div className="legal-actions"><Select label="المستخدم" value={accessUser} onChange={e=>setAccessUser(e.target.value)}><option value="">اختر مستخدمًا</option>{(people.data?.items??[]).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select><Select label="الصلاحية" value={accessRole} onChange={e=>setAccessRole(e.target.value)}><option value="viewer">عرض فقط</option><option value="reporter">عرض وتقارير</option><option value="editor">تعديل ومتابعة</option></Select><Button disabled={!accessUser||busy} onClick={()=>void action(async()=>{await api("/legal/cases/"+caseId+"/access",{method:"PUT",body:{userId:Number(accessUser),role:accessRole}});})}>منح الصلاحية</Button></div>
 {(access.data?.items??[]).map(a=><p key={a.user_id}>{a.user_name} — {a.role} <Button variant="danger" onClick={()=>void action(async()=>{await api("/legal/cases/"+caseId+"/access",{method:"PUT",body:{userId:a.user_id,role:null}});})}>إلغاء الصلاحية</Button></p>)}</Card>:
 <Card title={tab==="unlinked"?"سجلات قديمة لم تربط بالقضايا":kinds.find(k=>k.id===tab)?.label||"السجلات"}>
 <div className="legal-actions">{((editor||(tab==="report"&&reporter))&&tab!=="unlinked")&&<Button onClick={()=>beginEntry(tab as Kind)}>إضافة سجل</Button>}{tab==="report"&&<span>يسمح بعدة تقارير يوميًا، دون محو ما سبق.</span>}</div>
 {entryEdit!==null&&<div className="legal-entry-edit"><h3>{entryEdit==="new"?"إضافة":"تعديل"} {kinds.find(k=>k.id===entryDraft.kind)?.label}</h3><EntryFields value={entryDraft} change={setEntryDraft} people={people.data?.items??[]}/><div className="legal-actions"><Button disabled={busy||!entryDraft.title.trim()} onClick={submitEntry}>حفظ</Button><Button variant="secondary" onClick={()=>setEntryEdit(null)}>إلغاء</Button></div></div>}
 {(visible.length===0&&!entryEdit)&&<Notice>لا توجد سجلات هنا حاليًا.</Notice>}
 {visible.map(r=><article key={r.id} className="legal-entry"><div className="legal-entry-title"><div><small>#{r.id} · {r.record_date?.slice(0,10)||""}</small><h3>{r.title}</h3></div><div className="legal-actions">{editor&&<Button variant="secondary" onClick={()=>beginEntry(r.kind,r)}>تعديل</Button>}<Button variant="secondary" onClick={()=>setFocus(focus===r.id?null:r.id)}>الروابط والمرفقات</Button>{r.kind==="report"&&editor&&<Button variant="secondary" onClick={()=>beginEntry("task")}>إضافة مهمة</Button>}</div></div>
 {r.body&&<p className="legal-preserve">{r.body}</p>}
 {r.legacy_snapshot&&<details className="legal-legacy"><summary>جميع حقول السجل الأصلي</summary><pre>{JSON.stringify(r.legacy_snapshot,null,2)}</pre></details>}
 {r.kind==="document"&&<div className="legal-doc">{r.content_text&&<details><summary>النص الكامل للمستند</summary><p className="legal-preserve">{r.content_text}</p></details>}
 {r.pdf_url&&<a target="_blank" rel="noreferrer" href={r.pdf_url}>رابط PDF</a>}
 {r.drive_file_id&&<span>Drive: {r.drive_file_id}</span>}
 {(r.image_urls??[]).map((url,i)=><a key={url+i} target="_blank" rel="noreferrer" href={url}>صورة {i+1}</a>)}
 </div>}
 {r.kind==="report"&&<p className="legal-meta">المرسل: {r.creator_name||r.created_by} · {new Date(r.created_at).toLocaleString("ar-YE")} · {r.reviewed_at?"اطُّلع عليه":"بانتظار المراجعة"} {owner&&!r.reviewed_at&&<Button variant="secondary" onClick={()=>void action(async()=>{await api("/legal/records/"+r.id+"/review",{method:"POST"});})}>اعتماد الاطلاع</Button>}</p>}
 {r.kind==="task"&&<div className="legal-actions"><span>الموعد: {r.due_at?.slice(0,16)||"غير محدد"}</span><Select value={r.status||"pending"} disabled={!owner&&r.assigned_to!==user?.id&&!editor} onChange={e=>void action(async()=>{await api("/legal/records/"+r.id+"/task-status",{method:"POST",body:{status:e.target.value}});})}><option value="pending">مطلوبة</option><option value="working">جارٍ العمل</option><option value="submitted">تم الإبلاغ</option><option value="blocked">متعذرة</option>{owner&&<option value="verified">تم التحقق</option>}</Select></div>}
 {focus===r.id&&links.data&&<div className="legal-linked"><div>القضايا المرتبطة: {links.data.caseIds.join("، ")||"لا توجد"}</div><div>السجلات المرتبطة: {links.data.linkedIds.map(i=>"#"+i).join("، ")||"لا توجد"}</div>
 {owner&&tab==="unlinked"&&caseId>0&&<Button onClick={()=>void action(async()=>{await api("/legal/records/"+r.id+"/cases",{method:"POST",body:{caseId,linked:true}});})}>ربط بالقضية الحالية</Button>}
 {editor&&<div className="legal-actions"><Field label="رقم سجل للربط" type="number" value={linkNumber} onChange={e=>setLinkNumber(e.target.value)}/><Button disabled={!Number(linkNumber)} onClick={()=>void action(async()=>{await api("/legal/records/"+r.id+"/links",{method:"POST",body:{otherId:Number(linkNumber),linked:true}});setLinkNumber("");})}>ربط</Button></div>}
 {r.kind==="document"&&<><div className="legal-doc-images">{links.data.images.map(img=><a key={img.id} target="_blank" rel="noreferrer" href={"/api/legal/images/"+img.id}><img src={"/api/legal/images/"+img.id} alt={img.filename||"صورة مستند"}/></a>)}</div>
 {editor&&<label>رفع صورة للمستند (حتى 2MB للصورة) <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>imageUpload(r.id,e.target.files?.[0])}/></label>}</>}
 </div>}</article>)}
 </Card>}
 </>:<Card title="اختر قضية"><p>اختر قضية من القائمة لعرض سجلاتها ومعطياتها ومستنداتها وتقاريرها.</p></Card>}
 </div></div></div>;
}
