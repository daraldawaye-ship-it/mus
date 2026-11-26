import { z } from "zod";
import type { Pool } from "pg";
import { HttpError } from "./errors.ts";
import { transaction } from "./db.ts";
const section="أسماء الصور";
const english="الاسم بالإنجليزي", composition="التركيب", manufacturer="الشركة المصنّعة", review="حالة قراءة العبوة";
export const marketImageLabelBatchSchema=z.object({entries:z.array(z.object({
 position:z.number().int().min(1).max(1000),filename:z.string().min(1).max(600),
 englishName:z.string().trim().min(2).max(150).regex(/[A-Za-z]/).optional(),
 composition:z.string().trim().min(2).max(300).optional(),
 manufacturer:z.string().trim().min(2).max(200).optional(),
 reviewStatus:z.enum(["مراجعة بصرية","نسخة مطابقة لصورة مراجعة","مراجعة بصرية — غير محسومة"]).optional(),
}).strict().refine(x=>x.englishName||x.composition||x.manufacturer||x.reviewStatus)).min(1).max(50)}).strict()
.refine(x=>new Set(x.entries.map(e=>e.position)).size===x.entries.length);
async function source(db:Pick<Pool,"query">,sourceId:number){
 const s=await db.query("SELECT filename FROM market_import_sources WHERE id=$1 AND metadata->>'format'='image-filename-index'",[sourceId]);
 if(!s.rowCount)throw new HttpError(404,"image_label_source","مصدر أسماء الصور غير موجود");
 return s.rows[0].filename as string;
}
export async function listMarketImageLabels(pool:Pool,sourceId:number){
 const archiveName=await source(pool,sourceId);
 const r=await pool.query(`SELECT position,payload->>'اسم الملف' AS filename,
  payload->>'الاسم عربي من الملف' AS "sourceArabicName",
  payload->>$3 AS "englishName",payload->>$4 AS composition,payload->>$5 AS manufacturer,payload->>$6 AS "reviewStatus"
 FROM market_import_rows WHERE source_id=$1 AND section=$2 AND market_card_id IS NULL
  AND payload->>'معرف الصنف من الموقع' IS NULL ORDER BY position`,[sourceId,section,english,composition,manufacturer,review]);
 return {sourceId,archiveName,items:r.rows,total:r.rows.length};
}
export async function saveMarketImageLabels(pool:Pool,sourceId:number,batch:z.infer<typeof marketImageLabelBatchSchema>){
 return transaction(pool,async db=>{
  await source(db,sourceId);
  const entries=batch.entries.map(e=>({position:e.position,filename:e.filename,english:e.englishName??null,composition:e.composition??null,manufacturer:e.manufacturer??null,review:e.reviewStatus??null}));
  const r=await db.query(`UPDATE market_import_rows r SET payload=r.payload||
    jsonb_strip_nulls(jsonb_build_object(
      $4::text,CASE WHEN r.payload->>$4 IS NULL THEN e.english ELSE NULL END,
      $5::text,CASE WHEN r.payload->>$5 IS NULL THEN e.composition ELSE NULL END,
      $6::text,CASE WHEN r.payload->>$6 IS NULL THEN e.manufacturer ELSE NULL END,
      $7::text,CASE WHEN r.payload->>$7 IS NULL THEN e.review ELSE NULL END))
    FROM jsonb_to_recordset($1::jsonb) AS e(position int,filename text,english text,composition text,manufacturer text,review text)
    WHERE r.source_id=$2 AND r.section=$3 AND r.position=e.position AND r.market_card_id IS NULL
      AND r.payload->>'معرف الصنف من الموقع' IS NULL AND r.payload->>'اسم الملف'=e.filename
      AND ((r.payload->>$4 IS NULL AND e.english IS NOT NULL)
        OR (r.payload->>$5 IS NULL AND e.composition IS NOT NULL)
        OR (r.payload->>$6 IS NULL AND e.manufacturer IS NOT NULL)
        OR (r.payload->>$7 IS NULL AND e.review IS NOT NULL))
    RETURNING r.position,r.payload->>$4 AS "englishName",r.payload->>$5 AS composition,r.payload->>$6 AS manufacturer,r.payload->>$7 AS "reviewStatus"`,
    [JSON.stringify(entries),sourceId,section,english,composition,manufacturer,review]);
  return {sourceId,requested:entries.length,updated:r.rows};
 });
}
