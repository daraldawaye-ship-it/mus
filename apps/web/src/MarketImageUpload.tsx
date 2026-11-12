import { useState, type ChangeEvent } from "react";
import { api } from "./api";
import { MarketProductImage } from "./MarketProductImage";

const MAX_INPUT_BYTES=12*1024*1024;
const DATA_PREFIX="data:image/webp;base64,";
type Uploaded={url:string;bytes:number;width:number;height:number};
type PictureProfile="medicine"|"prescription";

/** GIF (including .gif files without a MIME label) becomes one still WebP.
 * createImageBitmap reads the default/first animation frame; canvas strips metadata.
 * Only the encoded result is uploaded. The source file never enters storage.
 */
export async function prepareMarketImage(file:File,_profile:PictureProfile="medicine"){
  const gif=file.type.toLowerCase()==="image/gif" || /\.gif$/i.test(file.name);
  if((!file.type.startsWith("image/")&&!gif)||file.size>MAX_INPUT_BYTES||file.size===0)
    throw Error("اختر صورة أو GIF لا يزيد حجم ملفها قبل الضغط عن 12 ميجابايت");
  const image=await createImageBitmap(file);
  try{
    if(image.width<1||image.height<1||image.width*image.height>30_000_000)
      throw Error("أبعاد الصورة غير مدعومة");
    const canvas=document.createElement("canvas");
    const ctx=canvas.getContext("2d");
    if(!ctx)throw Error("المتصفح لا يدعم تجهيز الصور");
    for(const ratio of [1,0.85,0.7,0.5]){
      const scale=Math.min(1,1200*ratio/Math.max(image.width,image.height));
      canvas.width=Math.max(1,Math.round(image.width*scale));
      canvas.height=Math.max(1,Math.round(image.height*scale));
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      let fallback:{dataUrl:string;bytes:number}|null=null;
      for(const quality of [0.85,0.8,0.72,0.62,0.5,0.38,0.28]){
        const dataUrl=canvas.toDataURL("image/webp",quality);
        if(!dataUrl.startsWith(DATA_PREFIX))throw Error("هذا المتصفح لا يدعم حفظ صور WebP");
        const encoded=dataUrl.slice(DATA_PREFIX.length);
        const bytes=encoded.length*3/4-(encoded.endsWith("==")?2:encoded.endsWith("=")?1:0);
        if(bytes<=150*1024)return {dataUrl,bytes,width:canvas.width,height:canvas.height};
        if(bytes<=200*1024&&!fallback)fallback={dataUrl,bytes};
      }
      if(fallback)return {...fallback,width:canvas.width,height:canvas.height};
    }
    throw Error("تعذر ضغط الصورة إلى 200 كيلوبايت؛ اختر صورة بخلفية أبسط");
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
  const preview=typeof value==="string" &&
    (/^https:\/\//i.test(value)||/^\/api\/medicine-market\/images\/[a-f0-9-]{36}$/.test(value))
      ?value:null;
  async function upload(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];
    event.target.value="";
    if(!file)return;
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
    <label>{prescription?"صورة الوصفة الطبية — قابلة للاستبدال":"صورة الكرت — رفع من الجهاز"}</label>
    {prescription&&<small className="muted">
      الصورة المرفوعة تظل خاصة قيد مراجعة الإدارة. يمكنك حفظها وتعديلها ثم رفع صورة بديلة قبل اعتماد النشر.
    </small>}
    <div className="image-upload-controls">
      {preview&&<MarketProductImage className="image-upload-preview" src={preview}
        trimLegacyPadding={!prescription}
        style={{maxWidth:260,maxHeight:380,width:"auto",height:"auto",objectFit:"contain"}}
        alt={prescription?"معاينة الوصفة":"معاينة صورة الكرت"}/>}
      <input type="file" accept="image/*,.gif"
        aria-label={prescription?"اختر صورة بديلة للوصفة":"اختر صورة للكرت"}
        onChange={(event)=>void upload(event)}
        disabled={disabled||busy}/>
      {preview&&!prescription&&<button type="button" disabled={disabled||busy}
        onClick={()=>{onChange(null);setSize(null);setError("");}}>إزالة الصورة</button>}
    </div>
    <small className="muted">
      WebP حتى 200 كيلوبايت و1200 بكسل + أيقونة حتى 16 كيلوبايت و64 بكسل فقط.
      GIF مسموحة وتُحفظ صورة ثابتة؛ لا يُحفظ الملف الأصلي أو نسخة معاينة ثالثة.
    </small>
    {busy&&<small aria-live="polite">جارٍ تجهيز الصورة ورفعها…</small>}
    {size!==null&&!busy&&<small aria-live="polite">حجم الصورة المرفوعة: {Math.round(size/1024)} كيلوبايت. تُرسل المساهمة تلقائيًا.</small>}
    {error&&<small role="alert" className="image-upload-error">{error}</small>}
  </div>;
}
