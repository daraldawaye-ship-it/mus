import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";
import "./ArchivePage.css";

type Category={id:number;name:string;showInLegal:boolean};
type FileRow={
  id:number;companyId:number|null;categoryId:number;categoryName:string;
  title:string;filename:string;mimeType:string;createdBy:number;creatorName:string;
  createdAt:string;updatedAt:string;revision:number;fileUrl:string;
  contentPreview?:string;evidencePreview?:string;contentText?:string;evidenceText?:string;
};
type FilesPage={items:FileRow[];total:number;page:number;pageSize:number};
const maxBytes=8*1024*1024;
const accepted="image/jpeg,image/png,image/webp,image/gif,application/pdf";
function message(error:unknown){return error instanceof Error?error.message:"تعذر إكمال العملية";}
function fileDataUrl(file:File):Promise<string>{
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>typeof reader.result==="string"?resolve(reader.result):reject(new Error("تعذر قراءة الملف"));
    reader.onerror=()=>reject(new Error("تعذر قراءة الملف"));
    // Keep the original bytes: GIF frames and animation must never be flattened.
    reader.readAsDataURL(file);
  });
}

export function ArchivePage({companyId}:{companyId?:number}){
  const {user}=useSession(),directory=usePageDirectory(companyId),location=useLocation(),cache=useQueryClient();
  const legalOnly=companyId===undefined&&new URLSearchParams(location.search).get("legal")==="1";
  const scope=companyId===undefined?"":`companyId=${companyId}`;
  const pageKey=companyId===undefined?"public.archive":"company.archive";
  const action=directory.data?.find(item=>item.key===pageKey)?.actionAccess;
  const canCreate=!!action?.create,canEdit=!!action?.edit;
  const fileInput=useRef<HTMLInputElement|null>(null);
  const [category,setCategory]=useState(""),[title,setTitle]=useState("");
  const [selectedFiles,setSelectedFiles]=useState<File[]>([]);
  const [search,setSearch]=useState(""),[categoryFilter,setCategoryFilter]=useState("");
  const [page,setPage]=useState(1),[selectedId,setSelectedId]=useState<number|null>(null);
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState(""),[error,setError]=useState(""),[success,setSuccess]=useState("");
  const [editing,setEditing]=useState(false),[contentText,setContentText]=useState(""),[evidenceText,setEvidenceText]=useState("");
  const categoryUrl="/archive/categories?"+new URLSearchParams({
    ...(companyId===undefined?{}:{companyId:String(companyId)}),
    ...(legalOnly?{legalOnly:"true"}:{}),
  });
  const categories=useQuery({
    queryKey:["archive","categories",user?.id,companyId??null,legalOnly],
    queryFn:({signal})=>api<{items:Category[]}>(categoryUrl,{signal}),
    enabled:!!user,
  });
  const listUrl="/archive/files?"+new URLSearchParams({
    ...(companyId===undefined?{}:{companyId:String(companyId)}),
    q:search,page:String(page),pageSize:"20",
    ...(categoryFilter?{categoryId:categoryFilter}:{}),
    ...(legalOnly?{legalOnly:"true"}:{}),
  });
  const list=useQuery({
    queryKey:["archive","files",user?.id,companyId??null,legalOnly,search,categoryFilter,page],
    queryFn:({signal})=>api<FilesPage>(listUrl,{signal}),
    enabled:!!user,
  });
  const details=useQuery({
    queryKey:["archive","file",user?.id,selectedId],
    queryFn:({signal})=>api<{record:FileRow}>(`/archive/files/${selectedId}`,{signal}),
    enabled:!!user&&selectedId!==null,
  });
  useEffect(()=>{
    if(details.data?.record){
      setContentText(details.data.record.contentText??"");
      setEvidenceText(details.data.record.evidenceText??"");
      setEditing(false);
    }
  },[details.data?.record.id,details.data?.record.revision]);
  async function upload(){
    if(!canCreate||!category.trim()||!title.trim()||!selectedFiles.length)return;
    setBusy(true);setError("");setSuccess("");setProgress("");
    let uploaded=0;const problems:string[]=[];
    try{
      for(let i=0;i<selectedFiles.length;i+=3){
        const batch=selectedFiles.slice(i,i+3);
        const results=await Promise.allSettled(batch.map(async(file)=>{
          if(file.size===0||file.size>maxBytes)throw new Error("الحجم يجب ألا يتجاوز 8 ميجابايت");
          if(!["image/gif","image/jpeg","image/png","image/webp","application/pdf"].includes(file.type))
            throw new Error("صيغة الملف غير مدعومة");
          const dataUrl=await fileDataUrl(file);
          return api<{id:number}>("/archive/files",{
            method:"POST",
            body:{companyId:companyId??null,category:category.trim(),title:title.trim(),
              filename:file.name,dataUrl},
          });
        }));
        results.forEach((result,index)=>{
          if(result.status==="fulfilled")uploaded++;
          else problems.push(batch[index].name+": "+message(result.reason));
        });
        setProgress(`تم حفظ ${uploaded} من ${selectedFiles.length} ملف`);
      }
      if(uploaded){
        await cache.invalidateQueries({queryKey:["archive"]});
        setPage(1);
        setSuccess(`تم إنشاء ${uploaded} سجل مستقل وربط كل سجل بملفه.`);
      }
      if(problems.length)setError("تعذر رفع بعض الملفات: "+problems.slice(0,5).join("، "));
      if(!problems.length){
        setSelectedFiles([]);
        if(fileInput.current)fileInput.current.value="";
      }else{
        const failedNames=new Set(problems.map(s=>s.split(":")[0]));
        setSelectedFiles(current=>current.filter(f=>failedNames.has(f.name)));
      }
    }finally{setBusy(false);}
  }
  async function save(){
    const record=details.data?.record;
    if(!record||!canEdit)return;
    setBusy(true);setError("");setSuccess("");
    try{
      await api(`/archive/files/${record.id}`,{method:"PATCH",body:{
        revision:record.revision,contentText,evidenceText,
      }});
      await cache.invalidateQueries({queryKey:["archive"]});
      setSuccess("تم حفظ المحتوى ووجه الاستدلال لهذا الملف فقط.");
      setEditing(false);
    }catch(reason){setError(message(reason));}
    finally{setBusy(false);}
  }
  async function setLegal(categoryItem:Category,enabled:boolean){
    setBusy(true);setError("");setSuccess("");
    try{
      await api(`/archive/categories/${categoryItem.id}`,{
        method:"PATCH",body:{showInLegal:enabled},
      });
      await cache.invalidateQueries({queryKey:["archive"]});
      setSuccess(enabled?"أصبحت الفئة ظاهرة في قائمة أرشيف القضايا.":"أُخفيت الفئة من قائمة أرشيف القضايا.");
    }catch(reason){setError(message(reason));}
    finally{setBusy(false);}
  }
  const record=details.data?.record;
  return <div className="archive-workspace">
    <PageHeader title={companyId===undefined?"أرشيف المستندات والمرفقات":"أرشيف مستندات الشركة"}
      description={companyId===undefined?"الأرشيف العام مستقل عن القضايا؛ يمكن إظهار فئات مختارة في القضايا.":"المستندات المحفوظة تخص هذه الشركة فقط."}
      actions={legalOnly?<Link className="button button-secondary" to="/archive">جميع فئات الأرشيف</Link>:undefined}/>
    {error&&<Notice tone="error">{error}</Notice>}
    {success&&<Notice tone="success">{success}</Notice>}
    {canCreate&&!legalOnly&&<Card title="إضافة مرفقات متعددة" description="تُكرر الفئة واسم المرفق لكل صورة أو ملف، ويُنشأ رابط وسجل مستقل لكل واحد.">
      <div className="archive-upload-fields">
        <div className="field"><label htmlFor="archive-category">الفئة</label>
          <input id="archive-category" list="archive-category-options" value={category}
            onChange={e=>setCategory(e.target.value)} maxLength={200} placeholder="اكتب فئة أو اختر الموجودة"/>
          <datalist id="archive-category-options">{(categories.data?.items??[]).map(c=><option value={c.name} key={c.id}/>)}</datalist>
        </div>
        <Field label="اسم المرفق المشترك" value={title} maxLength={300} onChange={e=>setTitle(e.target.value)}
          placeholder="اسم يظهر في كل سجل" />
        <div className="field"><label htmlFor="archive-files-input">الصور والملفات</label>
          <input id="archive-files-input" ref={fileInput} type="file" accept={accepted} multiple
            onChange={e=>setSelectedFiles(Array.from(e.target.files??[]))} disabled={busy}/>
          <small>JPG، PNG، WebP، GIF متحرك، PDF — حتى 8 ميجابايت لكل ملف</small>
        </div>
      </div>
      {!!selectedFiles.length&&<p className="archive-upload-count">{selectedFiles.length} ملفات مختارة</p>}
      <Button type="button" disabled={busy||!title.trim()||!category.trim()||!selectedFiles.length}
        onClick={()=>void upload()}>{busy?"جارٍ الحفظ…":"تحميل وإنشاء السجلات"}</Button>
      {progress&&<small role="status"> {progress}</small>}
    </Card>}
    {companyId===undefined&&!legalOnly&&canEdit&&<Card title="الفئات التي تظهر في القضايا"
      description="حدد الفئات المطلوبة فقط. تبقى المستندات محفوظة في الأرشيف العام نفسه دون نسخها إلى القضايا.">
      <div className="archive-category-options">
        {(categories.data?.items??[]).map(c=><label key={c.id} className="archive-category-toggle">
          <input type="checkbox" checked={c.showInLegal} disabled={busy}
            onChange={e=>void setLegal(c,e.target.checked)}/>{c.name}
        </label>)}
        {!categories.data?.items.length&&<span className="muted">ستظهر الفئات بعد إضافة أول ملف.</span>}
      </div>
    </Card>}
    <Card title="جدول الأرشيف">
      <div className="archive-filters">
        <Field label="بحث" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}
          placeholder="اسم المرفق أو الملف أو المحتوى"/>
        <Select label="الفئة" value={categoryFilter} onChange={e=>{setCategoryFilter(e.target.value);setPage(1);}}>
          <option value="">كل الفئات</option>
          {(categories.data?.items??[]).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>
      {list.isPending&&<Notice>جارٍ تحميل السجلات…</Notice>}
      {list.error&&<Notice tone="error">{message(list.error)}</Notice>}
      <div className="archive-table-scroll"><table className="archive-table">
        <thead><tr><th>الفئة</th><th>اسم المرفق</th><th>الرابط</th><th>أُنشئ بواسطة</th>
          <th>المحتوى</th><th>وجه الاستدلال</th><th>الإجراءات</th></tr></thead>
        <tbody>{(list.data?.items??[]).map(item=><tr key={item.id}>
          <td>{item.categoryName}</td><td>{item.title}<small className="archive-filename">{item.filename}</small></td>
          <td><a href={item.fileUrl} target="_blank" rel="noreferrer">فتح #{item.id}</a></td>
          <td>{item.creatorName}</td><td className="archive-preview-cell">{item.contentPreview||"—"}</td>
          <td className="archive-preview-cell">{item.evidencePreview||"—"}</td>
          <td><Button size="compact" variant="secondary" onClick={()=>{setSelectedId(item.id);setEditing(false);}}>
            عرض / تعديل</Button></td>
        </tr>)}</tbody>
      </table></div>
      {!list.isPending&&!list.data?.items.length&&<Notice>لا توجد مستندات مطابقة.</Notice>}
      <div className="archive-pagination">
        <span>الإجمالي: {list.data?.total??0}</span>
        <Button variant="secondary" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>السابق</Button>
        <span>صفحة {page}</span>
        <Button variant="secondary" disabled={page*20>=(list.data?.total??0)} onClick={()=>setPage(p=>p+1)}>التالي</Button>
      </div>
    </Card>
    {selectedId!==null&&<Card title="كرت المرفق">
      {details.isPending&&<Notice>جارٍ تحميل الكرت…</Notice>}
      {details.error&&<Notice tone="error">{message(details.error)}</Notice>}
      {record&&<div className="archive-detail">
        <div className="archive-detail-heading">
          <div><strong>{record.title}</strong><small>{record.categoryName} · #{record.id} · رفعه {record.creatorName}</small></div>
          <div className="archive-detail-actions">
            <a className="button button-secondary" href={record.fileUrl} target="_blank" rel="noreferrer">فتح الملف</a>
            <a className="button button-secondary" href={record.fileUrl} download={record.filename||undefined}>تنزيل</a>
            {canEdit&&<Button variant="secondary" onClick={()=>setEditing(value=>!value)}>{editing?"إلغاء التعديل":"تعديل"}</Button>}
            <Button variant="ghost" onClick={()=>setSelectedId(null)}>إغلاق</Button>
          </div>
        </div>
        <div className="archive-file-viewer">
          {record.mimeType==="application/pdf"
            ? <iframe title={record.filename||"ملف PDF"} src={record.fileUrl}/>
            : <img src={record.fileUrl} alt={record.title}/>}
        </div>
        {editing&&canEdit?<div className="archive-text-fields">
          <label>المحتوى<textarea rows={8} maxLength={500000} value={contentText}
            onChange={e=>setContentText(e.target.value)}/></label>
          <label>وجه الاستدلال<textarea rows={8} maxLength={500000} value={evidenceText}
            onChange={e=>setEvidenceText(e.target.value)}/></label>
          <Button disabled={busy} onClick={()=>void save()}>حفظ التعديل</Button>
        </div>:<div className="archive-text-fields">
          <div><strong>المحتوى</strong><p>{record.contentText||"لم يُكتب بعد"}</p></div>
          <div><strong>وجه الاستدلال</strong><p>{record.evidenceText||"لم يُكتب بعد"}</p></div>
        </div>}
      </div>}
    </Card>}
  </div>;
}
