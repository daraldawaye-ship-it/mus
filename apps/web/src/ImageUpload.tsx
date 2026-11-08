import { useRef, useState, type ChangeEvent } from "react";
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
/** Preserve the *entire* logo in a padded square rendition.
 * Cropping the upper 72% discarded the pharmacy name and part of its curve.
 * Keep the transparent background and the complete original image intact.
 */
function logoIcon(bitmap:ImageBitmap):string{
  const canvas=document.createElement("canvas");
  canvas.width=192;canvas.height=192;
  const ctx=canvas.getContext("2d");
  if(!ctx)throw new Error("المتصفح لا يدعم تجهيز الأيقونة");
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality="high";
  const padding=8;
  const available=192-padding*2;
  const ratio=Math.min(available/bitmap.width,available/bitmap.height);
  const width=bitmap.width*ratio;
  const height=bitmap.height*ratio;
  ctx.drawImage(bitmap,(192-width)/2,(192-height)/2,width,height);
  const result=canvas.toDataURL("image/webp",0.8);
  return result.startsWith("data:image/webp;")?result:canvas.toDataURL("image/png");
}
export function thumbnailUrl(full:string):string{
  return full.replace(/^(\/api\/media\/[a-f\d-]{36})\/full$/,"$1/thumbnail");
}
export function ImageUpload({
  purpose,companyId,preview,onUploaded,onClear,disabled=false,label,buttonLabel,
}:{
  purpose:"avatar"|"item"|"letterhead"|"logo";companyId?:number;preview?:string|null;label?:string;buttonLabel?:string;
  onUploaded:(asset:UploadedImage)=>void;onClear?:()=>void;disabled?:boolean;
}){
  const inputRef=useRef<HTMLInputElement>(null);
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
          purpose,companyId:purpose==="avatar"?null:(companyId??null),
          original:raster(bitmap,purpose==="letterhead"?2400:purpose==="logo"?1200:1440,0.86),
          thumbnail:purpose==="logo"?logoIcon(bitmap):raster(bitmap,purpose==="letterhead"?480:160,0.78),
        }
      });
      onUploaded(result);
    }catch(reason){
      setError(reason instanceof Error?reason.message:"تعذر رفع الصورة.");
    }finally{bitmap?.close();setBusy(false);}
  }
  return <div className="field image-upload">
    <label>{label??(purpose==="avatar"?"صورة المستخدم":purpose==="letterhead"?"صورة ترويسة الشركة":purpose==="logo"?"شعار الشركة":"صورة الصنف")}</label>
    <div className="image-upload-controls">
      {preview && <img className={purpose==="letterhead"?"image-upload-preview letterhead-upload-preview":"image-upload-preview"} src={preview} alt="معاينة الصورة" />}
      {buttonLabel&&<button type="button" className="button button-secondary"
        disabled={disabled||busy} onClick={()=>inputRef.current?.click()}>{buttonLabel}</button>}
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/*"
        aria-label={buttonLabel||"اختر صورة من جهازك"} style={buttonLabel?{display:"none"}:undefined}
        disabled={disabled||busy} onChange={(event)=>void upload(event)} />
      {preview && onClear && <button type="button" disabled={disabled||busy} onClick={onClear}>إزالة الصورة</button>}
    </div>
    {purpose!=="item" && <small className="muted">{purpose==="letterhead"
      ? "يفضّل رفع صورة أفقية عريضة واضحة (مثل 1600×200). تحفظ الصورة الكاملة للطباعة."
      : purpose==="logo"?"يفضّل شعارًا بخلفية شفافة. تُحفظ نسخة WebP مضغوطة وأيقونة مربعة منفصلة تلقائيًا."
      : "تُنشأ نسخة مصغرة تلقائيًا للعرض السريع في القوائم."}</small>}
    {busy && <small aria-live="polite">جارٍ تجهيز الصورة ورفعها…</small>}
    {error && <small className="image-upload-error" role="alert">{error}</small>}
  </div>;
}
