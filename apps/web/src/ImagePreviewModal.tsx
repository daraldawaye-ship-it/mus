import { useState, type ReactNode } from "react";
import { Dialog } from "./ui";
import "./ImagePreviewModal.css";
import { useMarketImage } from "./market-offline-images";

function MarketPreviewImage({ src, alt }: { src: string; alt: string }) {
  const image = useMarketImage(src);
  return image.failed ? <p>الصورة غير محفوظة على هذا الجهاز.</p> : <img src={image.src} alt={alt} />;
}

/** Keep image previews inside the installed application, including mobile PWA. */
export function ImagePreviewModal({src,alt="صورة",className,children,marketImage=false}:{
  src:string;alt?:string;className?:string;children?:ReactNode;marketImage?:boolean;
}){
  const [open,setOpen]=useState(false);
  return <>
    <button type="button" className="image-preview-trigger"
      aria-label={"معاينة "+alt} title="معاينة الصورة"
      onClick={event=>{event.stopPropagation();setOpen(true);}}>
      {children ?? <img src={src} alt={alt} className={className} loading="lazy"/>}
    </button>
    <Dialog open={open} onClose={()=>setOpen(false)} title="معاينة الصورة" className="image-preview-dialog">
      <div className="image-preview-content">
        {marketImage && open ? <MarketPreviewImage src={src} alt={alt} /> : !marketImage && <img src={src} alt={alt}/>}
      </div>
    </Dialog>
  </>;
}
