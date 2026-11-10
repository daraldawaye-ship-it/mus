import { useEffect, useState, type CSSProperties } from "react";
import { ImagePreviewModal } from "./ImagePreviewModal";

/**
 * Existing market photos were saved as 512x512 with a synthetic white frame.
 * Visually trim only that frame for display; leave the original stored bytes
 * and uploaded picture intact. New uploads keep their true aspect ratio.
 */
export function MarketProductImage({
  src,alt,className,style,trimLegacyPadding=true,
}:{
  src:string;
  alt:string;
  className?:string;
  style?:CSSProperties;
  trimLegacyPadding?:boolean;
}){
  const [display,setDisplay]=useState(src);
  useEffect(()=>{
    let active=true;
    setDisplay(src);
    if(!trimLegacyPadding || !/^\/api\/medicine-market\/images\/[a-f\d-]{36}$/.test(src))return;
    const photo=new Image();
    photo.onload=()=>{
      if(!active||photo.naturalWidth!==512||photo.naturalHeight!==512)return;
      try{
        const canvas=document.createElement("canvas");
        canvas.width=512;canvas.height=512;
        const context=canvas.getContext("2d",{willReadFrequently:true});
        if(!context)return;
        context.drawImage(photo,0,0);
        const rgba=context.getImageData(0,0,512,512).data;
        let left=512,right=-1,top=512,bottom=-1;
        // Detect white padding from the old upload pipeline, never crop dark
        // detail/printing; retain four pixels around the detected content.
        for(let y=0;y<512;y++)for(let x=0;x<512;x++){
          const i=(y*512+x)*4;
          if(rgba[i]>247 && rgba[i+1]>247 && rgba[i+2]>247 && rgba[i+3]>245)continue;
          if(x<left)left=x;
          if(x>right)right=x;
          if(y<top)top=y;
          if(y>bottom)bottom=y;
        }
        if(right-left<32||bottom-top<32)return;
        left=Math.max(0,left-4);
        top=Math.max(0,top-4);
        right=Math.min(511,right+4);
        bottom=Math.min(511,bottom+4);
        if(left<12 && top<12 && right>499 && bottom>499)return;
        const output=document.createElement("canvas");
        output.width=right-left+1;output.height=bottom-top+1;
        output.getContext("2d")?.drawImage(canvas,left,top,output.width,output.height,0,0,output.width,output.height);
        const trimmed=output.toDataURL("image/webp",0.85);
        if(active&&trimmed.startsWith("data:image/webp;"))setDisplay(trimmed);
      }catch{
        // Use original image if pixel access, WebP conversion or canvas fails.
      }
    };
    photo.src=src;
    return()=>{active=false;photo.onload=null;};
  },[src,trimLegacyPadding]);
  return <ImagePreviewModal src={src} alt={alt}>
    <img src={display} alt={alt} className={className}
      style={{maxWidth:"100%",height:"auto",objectFit:"contain",...style}}
      loading="lazy" decoding="async"/>
  </ImagePreviewModal>;
}
