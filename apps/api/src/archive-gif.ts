import { spawn } from "node:child_process";

/** Compress GIF bytes without flattening animated frames or modifying the
 * source. GIFsicle preserves frame delays, disposal and loop extensions. */
export async function compressArchiveGif(original:Buffer):Promise<Buffer>{
  if(original.length<1024)return original;
  const width=original.readUInt16LE(6),height=original.readUInt16LE(8);
  if(!width||!height||width*height>40_000_000)return original;
  const resize=width>height?"3508x2480":"2480x3508";
  // No conversion to a static image: preserving animation is required.
  const args=["--optimize=3","--lossy=20","--resize-fit",resize,"-"];
  try{
    const result=await new Promise<Buffer>((resolve,reject)=>{
      const child=spawn("gifsicle",args,{stdio:["pipe","pipe","pipe"]});
      const chunks:Buffer[]=[];
      let size=0;
      let failed=false;
      const fail=(error:Error)=>{
        if(failed)return;
        failed=true;
        child.kill();
        reject(error);
      };
      const timer=setTimeout(()=>fail(new Error("GIF compression timed out")),20000);
      child.stdout.on("data",(chunk:Buffer)=>{
        size+=chunk.length;
        if(size>original.length){fail(new Error("Output is not smaller"));return;}
        chunks.push(chunk);
      });
      child.stderr.on("data",()=>{ /* Do not expose uploaded content or tool output */ });
      child.on("error",error=>{clearTimeout(timer);fail(error);});
      child.on("close",code=>{
        clearTimeout(timer);
        if(failed)return;
        if(code!==0){reject(new Error("GIF compression failed"));return;}
        resolve(Buffer.concat(chunks));
      });
      child.stdin.on("error",()=>{ /* handled by child close */ });
      child.stdin.end(original);
    });
    if(result.length>=original.length || !["GIF87a","GIF89a"].includes(result.subarray(0,6).toString()))
      return original;
    return result;
  }catch{
    // Never block saving an attachment when optimization fails.
    return original;
  }
}
