import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, useSession } from "./api";
import { usePageDirectory } from "./page-directory";
import { currentDeviceKind } from "./device-kind";
import { Button, Dialog, Notice } from "./ui";

type Row = {
  id: number; file: File; progress: number;
  state: "ready" | "uploading" | "saved" | "failed"; error: string;
  serverId?: number; revision?: number; syncedSignature?: string;
};
const categories = ["فاتورة", "سند", "وصفة طبية", "أوراق رسمية", "آخر"];
const extensions = "jpg,jpeg,png,webp,gif,pdf,zip,rar,7z,doc,docx,xls,xlsx,ppt,pptx,txt,csv,rtf,mp3,wav,ogg,m4a,aac,flac,mp4,webm,mov";
const maximumBytes = 25 * 1024 * 1024;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result) : reject(new Error("تعذر قراءة الملف"));
    reader.onerror = () => reject(new Error("تعذر قراءة الملف"));
    reader.readAsDataURL(file);
  });
}
async function prepareFile(file: File): Promise<{ dataUrl: string; filename: string }> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!extensions.split(",").includes(extension)) throw new Error("صيغة الملف غير مدعومة");
  if (!file.size || file.size > maximumBytes) throw new Error("الحجم المسموح حتى 25 ميجابايت لكل ملف");
  // GIF remains unchanged so animated images retain their original frames.
  if (!["jpg", "jpeg", "png", "webp"].includes(extension)) {
    return { dataUrl: await readAsDataUrl(file), filename: file.name };
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 65_000_000)
      throw new Error("أبعاد الصورة كبيرة جدًا");
    // A4 at 300dpi: 2480 × 3508, preserving orientation and aspect ratio.
    const landscape = bitmap.width > bitmap.height;
    const widthLimit = landscape ? 3508 : 2480;
    const heightLimit = landscape ? 2480 : 3508;
    const scale = Math.min(1, widthLimit / bitmap.width, heightLimit / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("المتصفح لا يدعم ضغط الصور");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const compressed = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("تعذر تحويل الصورة إلى WebP")), "image/webp", 0.88));
    if (compressed.size > maximumBytes) throw new Error("الصورة كبيرة جدًا بعد الضغط");
    return {
      dataUrl: await readAsDataUrl(compressed),
      filename: file.name.replace(/\.[^.]+$/, "") + ".webp",
    };
  } finally { bitmap.close(); }
}


type UploadResult = { id: number };
function uploadWithProgress(body: unknown, token: string, onProgress: (percent: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/archive/files");
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("X-CSRF-Token", token);
    xhr.setRequestHeader("X-Alraesy-Device", currentDeviceKind());
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round(e.loaded / e.total * 100)));
    };
    xhr.onerror = () => reject(new Error("انقطع الاتصال أثناء الرفع"));
    xhr.onabort = () => reject(new Error("توقف الرفع"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText) as UploadResult;
          if (!Number.isInteger(parsed.id) || parsed.id <= 0) throw Error("missing id");
          onProgress(100);
          resolve(parsed);
        } catch { reject(new Error("لم يتم تأكيد رقم المرفق المحفوظ؛ راجع الأرشيف قبل إعادة المحاولة")); }
        return;
      }
      let error = "تعذر حفظ المرفق";
      try { error = JSON.parse(xhr.responseText)?.error?.message || error; } catch { /* unexpected response */ }
      reject(new Error(error));
    };
    xhr.send(JSON.stringify(body));
  });
}
const signature = (title: string, category: string) => JSON.stringify([title.trim(),category]);

/** Files are uploaded immediately on selection; metadata is shared and synchronized afterwards. */
export function QuickArchiveUpload() {
  const { user, csrf, offlineMode } = useSession();
  const directory = usePageDirectory();
  const canCreate = !!directory.data?.some(page =>
    page.key === "public.archive" && page.enabled && page.actionAccess.create);
  const cache = useQueryClient();
  const serial = useRef(1);
  const queue = useRef<Row[]>([]);
  const processing = useRef(false);
  const syncing = useRef(false);
  const rowsRef = useRef<Row[]>([]);
  const titleRef = useRef("");
  const categoryRef = useRef("آخر");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [sharedTitle, setSharedTitle] = useState("");
  const [sharedCategory, setSharedCategory] = useState("آخر");
  const [uploading, setUploading] = useState(false);
  const [syncingMetadata, setSyncingMetadata] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [metadataError, setMetadataError] = useState("");

  function replaceRows(next: Row[]) {
    rowsRef.current = next;
    setRows(next);
  }
  function patch(id: number, change: Partial<Row>) {
    replaceRows(rowsRef.current.map(row => row.id === id ? {...row,...change} : row));
  }
  function setTitle(value: string) {
    titleRef.current = value; setSharedTitle(value); setMetadataError("");
  }
  function setCategory(value: string) {
    categoryRef.current = value; setSharedCategory(value); setMetadataError("");
  }
  async function processQueue() {
    if (processing.current) return;
    processing.current = true;
    setUploading(true);
    try {
      while(queue.current.length) {
        const row = queue.current.shift()!;
        if (!csrf || offlineMode) {
          patch(row.id, {state:"failed",error:"يلزم اتصال بالإنترنت وتسجيل الدخول"});
          continue;
        }
        patch(row.id, {state:"uploading",progress:0,error:""});
        try {
          const prepared = await prepareFile(row.file);
          const title = titleRef.current.trim() || row.file.name.replace(/\.[^.]+$/, "");
          const category = categoryRef.current;
          const result = await uploadWithProgress({
            companyId:null,category,title,filename:prepared.filename,dataUrl:prepared.dataUrl,
          },csrf,percent=>patch(row.id,{progress:percent}));
          patch(row.id,{state:"saved",progress:100,serverId:result.id,revision:1,
            syncedSignature:signature(title,category)});
          void cache.invalidateQueries({queryKey:["archive"]});
        }catch(cause){
          patch(row.id,{state:"failed",error:cause instanceof Error?cause.message:"تعذر حفظ الملف"});
        }
      }
    }finally{
      processing.current = false;
      setUploading(false);
    }
  }
  function addFiles(files: File[]) {
    if(!files.length) return;
    if(!titleRef.current.trim()) setTitle(files[0].name.replace(/\.[^.]+$/, "").slice(0,300));
    const added:Row[] = files.map(file=>({
      id:serial.current++,file,progress:0,state:"ready",error:"",
    }));
    replaceRows([...rowsRef.current,...added]);
    queue.current.push(...added);
    setFeedback("");
    void processQueue();
  }
  async function syncMetadata() {
    if (syncing.current || !titleRef.current.trim() || !csrf || offlineMode) return;
    const wanted=signature(titleRef.current,categoryRef.current);
    const pending=rowsRef.current.filter(row=>row.serverId && row.revision &&
      row.syncedSignature!==wanted).slice(0,100);
    if(!pending.length)return;
    syncing.current=true;
    setSyncingMetadata(true);
    setMetadataError("");
    try{
      const response=await api<{items:{id:number;revision:number}[]}>("/archive/files/quick-metadata",{
        method:"PATCH",
        body:{items:pending.map(row=>({id:row.serverId!,revision:row.revision!})),
          title:titleRef.current.trim(),category:categoryRef.current},
      });
      const revisions=new Map(response.items.map(item=>[item.id,item.revision]));
      replaceRows(rowsRef.current.map(row=>{
        const revision=row.serverId?revisions.get(row.serverId):undefined;
        return revision?{...row,revision,syncedSignature:wanted}:row;
      }));
      await cache.invalidateQueries({queryKey:["archive"]});
    }catch(cause){
      setMetadataError(cause instanceof Error?cause.message:"تعذر تحديث أسماء المرفقات");
    }finally{
      syncing.current=false;
      setSyncingMetadata(false);
    }
  }
  useEffect(()=>{
    const wanted=signature(sharedTitle,sharedCategory);
    if(metadataError || !rows.some(row=>row.serverId && row.syncedSignature!==wanted))
      return;
    const timer=window.setTimeout(()=>{void syncMetadata();},450);
    return ()=>window.clearTimeout(timer);
  },[sharedTitle,sharedCategory,rows,metadataError]);

  if (!user || !canCreate) return null;
  const done=rows.filter(row=>row.state==="saved").length;
  const failures=rows.filter(row=>row.state==="failed");
  const allSaved=rows.length>0 && done===rows.length &&
    rows.every(row=>row.syncedSignature===signature(sharedTitle,sharedCategory));
  const busy=uploading||syncingMetadata;
  function close(){
    if(busy)return;
    setOpen(false);
    replaceRows([]);queue.current=[];
    setTitle("");setCategory("آخر");setFeedback("");setMetadataError("");
  }
  return <>
    <Button variant="secondary" onClick={()=>{setOpen(true);setFeedback("");}}>إضافة مرفق</Button>
    <Dialog open={open} title="إضافة مرفقات إلى الأرشيف العام" onClose={close}>
      <div className="form-stack">
        <input type="file" multiple accept={extensions.split(",").map(e=>"."+e).join(",")}
          onChange={event=>{
            addFiles(Array.from(event.target.files??[]));
            event.target.value="";
          }}/>
        <small>يبدأ الرفع والحفظ بمجرد اختيار الملفات، ويمكن تعديل الاسم والنوع للجميع أثناء الرفع وبعده. الصور الثابتة تتحول إلى WebP دون قص، وGIF يُضغط مع الحفاظ على الحركة. الحد 25 ميجابايت للملف.</small>
        {rows.length>0&&<>
          <div className="archive-upload-fields">
            <label className="field">اسم المرفق للجميع
              <input value={sharedTitle} maxLength={300} onChange={e=>setTitle(e.target.value)}
                placeholder="اسم واحد يطبق على جميع الملفات"/>
            </label>
            <label className="field">نوع المرفق للجميع
              <select value={sharedCategory} onChange={e=>setCategory(e.target.value)}>
                {categories.map(value=><option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          </div>
          <small>أي تغيير في الاسم أو النوع يُحفظ تلقائيًا في الملفات المرفوعة أيضًا، دون إعادة رفعها.</small>
          {rows.map(row=><div key={row.id} className="card" style={{padding:10,display:"grid",gap:6}}>
            <strong style={{overflowWrap:"anywhere"}}>{row.file.name}</strong>
            <progress value={row.progress} max={100} style={{width:"100%"}}/>
            <small role="status">{row.state==="saved"
              ?(row.syncedSignature===signature(sharedTitle,sharedCategory)?"✓ تم الحفظ":"جارٍ تحديث الاسم والنوع…")
              :row.state==="uploading"?"جارٍ الرفع "+row.progress+"%"
              :row.error||"بانتظار الرفع"}</small>
            {row.state==="failed"&&<Button size="compact" variant="secondary" onClick={()=>{
              patch(row.id,{state:"ready",error:"",progress:0});
              queue.current.push({...row,state:"ready",error:"",progress:0});
              void processQueue();
            }}>إعادة محاولة رفع الملف</Button>}
          </div>)}
          {allSaved
            ? <strong role="status">✓ تم حفظ جميع المرفقات ({done})</strong>
            : <small role="status">تم حفظ {done} من {rows.length} مرفق{uploading?" — جارٍ الرفع…":""}{syncingMetadata?" — جارٍ تحديث البيانات…":""}</small>}
          {!!failures.length&&<Notice tone="error">تعذر رفع {failures.length} مرفق. أعد المحاولة من الملف المعني.</Notice>}
        </>}
        {metadataError&&<Notice tone="error">{metadataError} <Button size="compact" onClick={()=>{setMetadataError("");void syncMetadata();}}>إعادة محاولة تحديث البيانات</Button></Notice>}
        {feedback&&<Notice>{feedback}</Notice>}
        <div className="form-actions">
          <Button variant="secondary" disabled={busy} onClick={close}>إغلاق</Button>
        </div>
      </div>
    </Dialog>
  </>;
}
