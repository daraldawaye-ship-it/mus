import { useState, type ChangeEvent } from "react";
import { api } from "./api";

interface UploadedImage {
  id: string;
  fullUrl: string;
  thumbnailUrl: string;
}
const MAX_FILE_BYTES=10*1024*1024;
function raster(bitmap:ImageBitmap,maxSide:number,quality:number):string{
  const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));
  canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext("2d");
  if(!ctx)throw new Error("المتصفح لا يدعم تجهيز الصور.");
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality="high";
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const webp=canvas.toDataURL("image/webp",quality);
  return webp.startsWith("data:image/webp;")?webp:canvas.toDataURL("image/jpeg",quality);
}
export function thumbnailUrl(full:string):string{
  return full.replace(/^(\/api\/media\/[a-f\d-]{36})\/full$/,"$1/thumbnail");
}
export function ImageUpload({
  purpose,companyId,preview,onUploaded,onClear,disabled=false,
}:{
  purpose:"avatar"|"item";companyId?:number;preview?:string|null;
  onUploaded:(asset:UploadedImage)=>void;onClear?:()=>void;disabled?:boolean;
}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function upload(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];event.target.value="";
    if(!file)return;
    if(!file.type.startsWith("image/")||file.size>MAX_FILE_BYTES){
      setError("اختر صورة بحجم لا يتجاوز 10 ميجابايت.");return;
    }
    setBusy(true);setError("");
    let bitmap:ImageBitmap|null=null;
    try{
      bitmap=await createImageBitmap(file);
      if(bitmap.width*bitmap.height>30_000_000)throw Error("دقة الصورة عالية جدًا.");
      const result=await api<UploadedImage>("/media",{
        method:"POST",
        body:{
          purpose,companyId:purpose==="item"?(companyId??null):null,
          original:raster(bitmap,1440,0.82),
          thumbnail:raster(bitmap,160,0.76),
        }
      });
      onUploaded(result);
    }catch(reason){
      setError(reason instanceof Error?reason.message:"تعذر رفع الصورة.");
    }finally{bitmap?.close();setBusy(false);}
  }
  return <div className="field image-upload">
    <label>{purpose==="avatar"?"صورة المستخدم":"صورة الصنف"}</label>
    <div className="image-upload-controls">
      {preview && <img className="image-upload-preview" src={preview} alt="معاينة الصورة" />}
      <input type="file" accept="image/png,image/jpeg,image/webp,image/*" aria-label="اختر صورة من جهازك"
        disabled={disabled||busy} onChange={(event)=>void upload(event)} />
      {preview && onClear && <button type="button" disabled={disabled||busy} onClick={onClear}>إزالة الصورة</button>}
    </div>
    <small className="muted">تُنشأ نسخة مصغرة تلقائيًا للعرض السريع في القوائم.</small>
    {busy && <small aria-live="polite">جارٍ تجهيز الصورة ورفعها…</small>}
    {error && <small className="image-upload-error" role="alert">{error}</small>}
  </div>;
}
