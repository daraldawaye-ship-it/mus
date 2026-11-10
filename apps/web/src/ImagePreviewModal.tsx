import { useState } from "react";
import { Dialog } from "./ui";
import "./ImagePreviewModal.css";

/** Keep image previews inside the installed application, including mobile PWA. */
export function ImagePreviewModal({src,alt="صورة",className}:{
  src:string;alt?:string;className?:string;
}){
  const [open,setOpen]=useState(false);
  return <>
    <button type="button" className="image-preview-trigger"
      aria-label={"معاينة "+alt} title="معاينة الصورة"
      onClick={()=>setOpen(true)}>
      <img src={src} alt={alt} className={className} loading="lazy"/>
    </button>
    <Dialog open={open} onClose={()=>setOpen(false)} title="معاينة الصورة" className="image-preview-dialog">
      <div className="image-preview-content">
        <img src={src} alt={alt}/>
      </div>
    </Dialog>
  </>;
}
