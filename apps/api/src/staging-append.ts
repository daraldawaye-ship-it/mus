import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import type { PoolClient } from "pg";
import { HttpError } from "./errors.ts";

export const stagingAppendSchema = z.object({
  idempotencyKey:z.string().uuid(), expectedRowCount:z.number().int().nonnegative(),
  filename:z.string().min(1).max(500), sourceLibraryId:z.string().min(1).max(200),
  sourceSha256:z.string().regex(/^[a-f0-9]{64}$/), dataSha256:z.string().regex(/^[a-f0-9]{64}$/),
  encoded:z.string().min(20).max(1000000), supplierType:z.literal("agent"),
}).strict();
const cell=z.object({column:z.number().int().min(1).max(20),value:z.union([z.string().max(10000),z.number(),z.null()]),type:z.string().max(20)}).strict();
const rowsSchema=z.array(z.object({sourceRow:z.number().int().min(2),cells:z.array(cell).min(5).max(20)}).strict()).min(1).max(10000);
export function unpackStagingAppend(input:z.infer<typeof stagingAppendSchema>){
  const raw=gunzipSync(Buffer.from(input.encoded,"base64"),{maxOutputLength:20000000});
  if(createHash("sha256").update(raw).digest("hex")!==input.dataSha256)throw new HttpError(400,"append_hash","بصمة بيانات الإلحاق مختلفة");
  const rows=rowsSchema.parse(JSON.parse(raw.toString("utf8")));
  const seen=new Set<number>();
  for(const row of rows){
    if(seen.has(row.sourceRow)||new Set(row.cells.map(c=>c.column)).size!==row.cells.length)throw new HttpError(400,"append_duplicate_row","تكرر سطر المصدر أو العمود");
    seen.add(row.sourceRow);
    if(!row.cells.some(c=>c.column===4&&typeof c.value==="string"&&c.value.trim()))throw new HttpError(400,"append_name","اسم الصنف مفقود");
  }
  return rows;
}
export async function appendStagingRows(db:PoolClient,sourceId:number,input:z.infer<typeof stagingAppendSchema>,actor:{id:number;displayName:string}){
  const rows=unpackStagingAppend(input);
  const found=await db.query("SELECT id,filename,row_count,metadata FROM market_import_sources WHERE id=$1 FOR UPDATE",[sourceId]);
  const source=found.rows[0];
  if(!source||!String(source.filename).includes("عبدالسلام"))throw new HttpError(400,"append_source","الإلحاق هنا خاص بجدول عبدالسلام");
  const batches=Array.isArray(source.metadata?.appendBatches)?source.metadata.appendBatches:[];
  const old=batches.find((x:Record<string,unknown>)=>x.id===input.idempotencyKey||x.sourceSha256===input.sourceSha256);
  if(old){
    if(old.sourceSha256!==input.sourceSha256||old.dataSha256!==input.dataSha256)throw new HttpError(409,"append_duplicate","مصدر أو مفتاح ببيانات مختلفة");
    return {...old,reused:true};
  }
  if(source.row_count!==input.expectedRowCount)throw new HttpError(409,"append_revision","تغير عدد صفوف المصدر؛ أعد القراءة");
  const positionResult=await db.query("SELECT coalesce(max(position),0)::integer AS n FROM market_import_rows WHERE source_id=$1 AND section='ورقة1'",[sourceId]);
  const first=Number(positionResult.rows[0].n)+1;
  const mapped=rows.map((row,index)=>{
    const get=(n:number)=>row.cells.find(c=>c.column===n)?.value??null;
    const make=(column:number,value:unknown)=>({column,value,type:typeof value==="number"?"n":"s",format:"General",cached:null});
    return {position:first+index,payload:JSON.stringify({cells:[make(1,get(1)),make(2,get(4)),make(3,get(3)),make(4,get(5)),make(6,get(2)),make(13,"أصناف وكلاء")],supplierType:"agent",supplierTypeSource:"owner",sourceFile:input.filename,sourceLibraryId:input.sourceLibraryId,sourceSha256:input.sourceSha256,sourceRow:row.sourceRow,sourceCells:row.cells,appendBatchId:input.idempotencyKey})};
  });
  for(let i=0;i<mapped.length;i+=250)await db.query("INSERT INTO market_import_rows(source_id,section,position,payload_text,payload) SELECT $1,'ورقة1',x.position,x.payload,x.payload::jsonb FROM jsonb_to_recordset($2::jsonb) AS x(position integer,payload text)",[sourceId,JSON.stringify(mapped.slice(i,i+250))]);
  const receipt={id:input.idempotencyKey,sourceSha256:input.sourceSha256,dataSha256:input.dataSha256,filename:input.filename,sourceLibraryId:input.sourceLibraryId,supplierType:"agent",rows:rows.length,firstPosition:first,lastPosition:first+rows.length-1,actorId:actor.id};
  const metadata={...source.metadata,originalRowsSupplierType:"unknown",appendBatches:[...batches,receipt]};
  await db.query("UPDATE market_import_sources SET row_count=row_count+$2,metadata=$3::jsonb WHERE id=$1",[sourceId,rows.length,JSON.stringify(metadata)]);
  await db.query("INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value) VALUES($1,$2,'public',NULL,'medicine-market.staging_append','market-import-source',$3,$4::jsonb,$5::jsonb)",[actor.id,actor.displayName,String(sourceId),JSON.stringify({rowCount:source.row_count}),JSON.stringify(receipt)]);
  return {...receipt,reused:false};
}
