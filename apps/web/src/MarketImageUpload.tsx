import { useState, type ChangeEvent } from "react";
import { api } from "./api";
import { MarketProductImage } from "./MarketProductImage";

const MAX_INPUT_BYTES=12*1024*1024;
const DATA_PREFIX="data:image/webp;base64,";
type Uploaded={url:string;bytes:number;width:number;height:number};
type PictureProfile="medicine"|"prescription";

/** Complete image, original aspect ratio, no white padding and no metadata. */
export async function prepareMarketImage(file:File,profile:PictureProfile="medicine"){
  if(!file.type.startsWith("image/")||file.size>MAX_INPUT_BYTES)
    throw Error("اختر صورة لا يزيد حجمها الأصلي عن 12 ميجابايت");
  const image=await createImageBitmap(file);
  try{
    if(image.width<1||image.height<1||image.width*image.height>30_000_000)
      throw Error("أبعاد الصورة غير مدعومة");
    const prescription=profile==="prescription";
    const maxSide=prescription?1600:512;
    const target=prescription?300*1024:80*1024;
    const maximum=prescription?500*1024:100*1024;
    const canvas=document.createElement("canvas");
    const ctx=canvas.getContext("2d");
    if(!ctx)throw Error("المتصفح لا يدعم تجهيز الصور");
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality="high";
    const ratios=prescription?[1,0.90,0.8,0.70]:[1];
    for(const ratio of ratios){
      const scale=prescription
        ?Math.min(1,maxSide*ratio/Math.max(image.width,image.height))
        :maxSide/Math.max(image.width,image.height);
      canvas.width=Math.max(1,Math.round(image.width*scale));
      canvas.height=Math.max(1,Math.round(image.height*scale));
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      let fallback:{dataUrl:string;bytes:number}|null=null;
      for(const quality of [0.85,0.8,0.74,0.68,0.60,0.53,0.45,0.38,0.30]){
        const dataUrl=canvas.toDataURL("image/webp",quality);
        if(!dataUrl.startsWith(DATA_PREFIX))
          throw Error("هذا المتصفح لا يدعم حفظ صور WebP");
        const bytes=Math.floor((dataUrl.length-DATA_PREFIX.length)*3/4);
        if(bytes<=target)return {dataUrl,bytes,width:canvas.width,height:canvas.height};
        fallback={dataUrl,bytes};
      }
      if(fallback && fallback.bytes<=maximum)
        return {...fallback,width:canvas.width,height:canvas.height};
    }
    throw Error(prescription
      ?"الصورة كبيرة جدًا بعد الضغط؛ اختر صورة أوضح بخلفية أبسط"
      :"تعذر ضغط الصورة إلى أقل من 100 كيلوبايت");
  } finally {image.close();}
}

export function MarketImageUpload({
  cardId,value,onChange,disabled=false,onBusyChange,prescription=false,
}:{
  cardId:number;
  value:unknown;
  onChange:(value:string|null)=>void;
  disabled?:boolean;
  onBusyChange?:(busy:boolean)=>void;
  prescription?:boolean;
}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [size,setSize]=useState<number|null>(null);
  const [privacyOk,setPrivacyOk]=useState(false);
  const preview=typeof value==="string" &&
    (/^https:\/\//i.test(value)||/^\/api\/medicine-market\/images\/[a-f0-9-]{36}$/.test(value))
      ?value:null;
  async function upload(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];
    event.target.value="";
    if(!file)return;
    if(prescription&&!privacyOk){
      setError("أخفِ بيانات المريض وأكد ذلك قبل رفع الوصفة");
      return;
    }
    setBusy(true);onBusyChange?.(true);setError("");setSize(null);
    try{
      const compressed=await prepareMarketImage(file,prescription?"prescription":"medicine");
      const result=await api<Uploaded>("/medicine-market/cards/"+cardId+"/images",{
        method:"POST",body:{dataUrl:compressed.dataUrl},
      });
      onChange(result.url);
      setSize(result.bytes);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"تعذر ضغط الصورة أو رفعها");
    }finally{
      setBusy(false);onBusyChange?.(false);
    }
  }
  return <div className="field image-upload">
    <label>{prescription?"صورة الوصفة الطبية — قابلة للاستبدال":"صورة الصنف — رفع من الجهاز"}</label>
    {prescription&&<label className="medicine-market-check">
      <input type="checkbox" checked={privacyOk}
        disabled={disabled||busy} onChange={e=>setPrivacyOk(e.target.checked)}/>
      أخفيت اسم المريض وبياناته الشخصية من الصورة قبل رفعها للجمهور
    </label>}
    <div className="image-upload-controls">
      {preview&&<MarketProductImage className="image-upload-preview" src={preview}
        trimLegacyPadding={!prescription}
        style={{maxWidth:260,maxHeight:380,width:"auto",height:"auto",objectFit:"contain"}}
        alt={prescription?"معاينة الوصفة":"معاينة صورة الصنف"}/>}
      <input type="file" accept="image/*"
        aria-label={prescription?"اختر صورة بديلة للوصفة":"اختر صورة صنف"}
        onChange={(event)=>void upload(event)}
        disabled={disabled||busy||(prescription&&!privacyOk)}/>
      {preview&&!prescription&&<button type="button" disabled={disabled||busy}
        onClick={()=>{onChange(null);setSize(null);setError("");}}>إزالة الصورة</button>}
    </div>
    <small className="muted">
      {prescription
       ?"يُحفظ كامل نص الوصفة بقدر الإمكان، دون قص، بصيغة WebP؛ حتى 1600 بكسل و500 كيلوبايت."
       :"الصورة كاملة دون قص، الضلع الأكبر 512 بكسل، بصيغة WebP؛ بحد 100 كيلوبايت."}
    </small>
    {busy&&<small aria-live="polite">جارٍ تجهيز الصورة ورفعها…</small>}
    {size!==null&&!busy&&<small aria-live="polite">رُفعت الصورة ({Math.round(size/1024)} كيلوبايت). اضغط «حفظ المساهمة» لاعتمادها.</small>}
    {error&&<small role="alert" className="image-upload-error">{error}</small>}
  </div>;
}
