import { useState, type ChangeEvent } from "react";
import { api } from "./api";

const MAX_INPUT_BYTES=12*1024*1024;
const MAX_OUTPUT_BYTES=100*1024;
const TARGET_BYTES=80*1024;
type Uploaded={url:string;bytes:number;width:number;height:number};

function squareWebp(bitmap:ImageBitmap):{dataUrl:string;bytes:number}{
  const canvas=document.createElement("canvas");
  canvas.width=512;
  canvas.height=512;
  const ctx=canvas.getContext("2d");
  if(!ctx)throw Error("المتصفح لا يدعم تجهيز الصور");
  ctx.fillStyle="#ffffff";
  ctx.fillRect(0,0,512,512);
  const side=480;
  const scale=Math.min(side/bitmap.width,side/bitmap.height);
  const width=Math.max(1,Math.round(bitmap.width*scale));
  const height=Math.max(1,Math.round(bitmap.height*scale));
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality="high";
  ctx.drawImage(bitmap,(512-width)/2,(512-height)/2,width,height);
  let fallback:{dataUrl:string;bytes:number}|null=null;
  for(const quality of [0.8,0.74,0.68,0.6,0.53,0.45,0.38,0.3]){
    const dataUrl=canvas.toDataURL("image/webp",quality);
    if(!dataUrl.startsWith("data:image/webp;base64,"))
      throw Error("هذا المتصفح لا يدعم حفظ الصور بصيغة WebP");
    const bytes=Math.floor((dataUrl.length-"data:image/webp;base64,".length)*3/4);
    if(bytes<=TARGET_BYTES)return {dataUrl,bytes};
    fallback={dataUrl,bytes};
  }
  if(fallback && fallback.bytes<=MAX_OUTPUT_BYTES)return fallback;
  throw Error("تعذر ضغط الصورة إلى أقل من 100 كيلوبايت؛ اختر صورة أقل تعقيدًا");
}

/** Browser-side sizing removes original metadata before uploads reach the market database. */
export function MarketImageUpload({
  cardId,value,onChange,disabled=false,onBusyChange,
}:{
  cardId:number;
  value:unknown;
  onChange:(value:string|null)=>void;
  disabled?:boolean;
  onBusyChange?:(busy:boolean)=>void;
}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [size,setSize]=useState<number|null>(null);
  const preview=typeof value==="string" &&
    (/^https:\/\//i.test(value)||/^\/api\/medicine-market\/images\/[a-f0-9-]{36}$/.test(value))
      ?value:null;
  async function upload(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];
    event.target.value="";
    if(!file)return;
    if(!file.type.startsWith("image/")||file.size>MAX_INPUT_BYTES){
      setError("اختر صورة من الجهاز بحجم لا يتجاوز 12 ميجابايت");
      return;
    }
    setBusy(true);onBusyChange?.(true);setError("");setSize(null);
    let bitmap:ImageBitmap|null=null;
    try {
      bitmap=await createImageBitmap(file);
      if(bitmap.width<1||bitmap.height<1||bitmap.width*bitmap.height>30_000_000)
        throw Error("أبعاد الصورة غير مدعومة");
      const square=squareWebp(bitmap);
      const result=await api<Uploaded>("/medicine-market/cards/"+cardId+"/images",{
        method:"POST",body:{dataUrl:square.dataUrl},
      });
      onChange(result.url);
      setSize(result.bytes);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"تعذر ضغط الصورة أو رفعها");
    }finally {
      bitmap?.close();
      setBusy(false);onBusyChange?.(false);
    }
  }
  return <div className="field image-upload">
    <label>صورة الصنف — رفع من الجهاز</label>
    <div className="image-upload-controls">
      {preview&&<img className="image-upload-preview" src={preview}
        style={{width:128,height:128,objectFit:"contain",background:"#fff"}}
        alt="معاينة صورة الصنف" loading="lazy"/>}
      <input type="file" accept="image/png,image/jpeg,image/webp,image/*"
        aria-label="اختر صورة صنف من الهاتف أو الكمبيوتر"
        onChange={(event)=>void upload(event)} disabled={disabled||busy}/>
      {preview&&<button type="button" disabled={disabled||busy}
        onClick={()=>{onChange(null);setSize(null);setError("");}}>إزالة الصورة</button>}
    </div>
    <small className="muted">تحويل تلقائي إلى مربع 512 × 512 بخلفية بيضاء دون قص العبوة، بصيغة WebP. المستهدف 80 كيلوبايت والأقصى 100 كيلوبايت.</small>
    {busy&&<small aria-live="polite">جارٍ تصغير الصورة وضغطها ورفعها…</small>}
    {size!==null&&!busy&&<small aria-live="polite">تم رفع الصورة المضغوطة ({Math.round(size/1024)} كيلوبايت). اضغط «حفظ المساهمة» لاعتماد إضافتها للكرت.</small>}
    {error&&<small role="alert" className="image-upload-error">{error}</small>}
  </div>;
}
