import { createHash } from "node:crypto";
import type { Pool } from "pg";
import sharp from "sharp";
import { z } from "zod";
import { transaction } from "./db.ts";
import { HttpError } from "./errors.ts";
const positive=z.number().int().positive().max(2147483647);
const sourceRef=z.object({sourceId:positive,position:positive,filename:z.string().min(1).max(600)}).strict();
export const stagingImageAssetsSchema=z.object({images:z.array(z.object({
 dataUrl:z.string().min(50).max(270000).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/),
 rows:z.array(sourceRef).min(1).max(100)
}).strict()).min(1).max(30)}).strict().refine(x=>{const keys=x.images.flatMap(i=>i.rows.map(r=>r.sourceId+":"+r.position));return keys.length<=500&&keys.length===new Set(keys).size;});
export const stagingImageAssetsOperation="POST /medicine-market/staging/preview-images";
export const stagingImagePath=(sourceId:number, position:number)=>`/api/medicine-market/staging/${sourceId}/rows/${position}/preview-image`;
const section="أسماء الصور";
export async function stageImageAssets(pool:Pool,actorId:number,input:z.infer<typeof stagingImageAssetsSchema>){
 if(Buffer.byteLength(JSON.stringify(input))>700*1024)throw new HttpError(413,"staging_image_batch_size","حجم دفعة الصور أكبر من المسموح");
 const items:{bytes:Buffer;sha256:string;rows:z.infer<typeof sourceRef>[]}[]=[];
 for(const image of input.images){
  const encoded=image.dataUrl.slice(23);
  const bytes=Buffer.from(encoded,"base64");
  if(bytes.length<30||bytes.length>200000||bytes.toString("base64")!==encoded)
   throw new HttpError(400,"staging_image_format","صورة WebP غير صالحة");
  try{
   const info=await sharp(bytes,{limitInputPixels:1440000}).metadata();
   if(info.format!=="webp"||!info.width||!info.height||info.width>1200||info.height>1200||(info.pages??1)>1)throw Error("format");
  }catch{throw new HttpError(400,"staging_image_format","صورة WebP غير صالحة أو تتجاوز المقاس");}
  items.push({bytes,sha256:createHash("sha256").update(bytes).digest("hex"),rows:image.rows});
 }
 return transaction(pool,async db=>{
  const rows=items.flatMap(({sha256,rows})=>rows.map(r=>({...r,sha256,url:stagingImagePath(r.sourceId,r.position)})));
  for(const item of items)await db.query("INSERT INTO market_staging_image_assets(sha256,webp,uploaded_by) VALUES($1,$2,$3) ON CONFLICT(sha256) DO NOTHING",[item.sha256,item.bytes,actorId]);
  const result=await db.query(`UPDATE market_import_rows r SET payload=r.payload||jsonb_build_object('الصورة',x.url,'stagingImageSha256',x.sha256)
   FROM jsonb_to_recordset($1::jsonb) AS x("sourceId" bigint,position int,filename text,sha256 text,url text),market_import_sources s
   WHERE r.source_id=x."sourceId" AND r.position=x.position AND r.section=$2 AND r.payload->>'اسم الملف'=x.filename
     AND s.id=r.source_id AND s.metadata->>'format'='image-filename-index'
     AND (r.payload->>'stagingImageSha256' IS NULL OR r.payload->>'stagingImageSha256'=x.sha256)
   RETURNING r.source_id AS "sourceId",r.position`,[JSON.stringify(rows),section]);
  if(result.rowCount!==rows.length)throw new HttpError(409,"staging_image_rows_changed","تغيّر اسم صف أو صورته؛ لم تُحفظ الدفعة");
  return {saved:result.rowCount,distinctAssets:new Set(items.map(i=>i.sha256)).size,rows:result.rows};
 });
}
export async function getStagedImageAsset(pool:Pool,sourceId:number,position:number){
 const r=await pool.query(`SELECT a.webp FROM market_import_rows r JOIN market_import_sources s ON s.id=r.source_id
  JOIN market_staging_image_assets a ON a.sha256=r.payload->>'stagingImageSha256'
  WHERE r.source_id=$1 AND r.position=$2 AND r.section=$3 AND s.metadata->>'format'='image-filename-index'`,[sourceId,position,section]);
 return r.rows[0]?.webp as Buffer|undefined;
}
