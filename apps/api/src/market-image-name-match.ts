import { buildImageAttributeIndex, matchImageAttributes } from "./market-image-attributes.ts";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { HttpError } from "./errors.ts";

export const imageNameMatchOperation = "POST /medicine-market/staging/image-filenames/match-easy";
export const imageNameMatchSchema = z.object({
  sourceIds:z.array(z.number().int().positive().max(2147483647)).min(1).max(30),
  mode:z.enum(["easy","attributes","investigated"]).default("easy"),
  expectedPreview:z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict().refine(x=>new Set(x.sourceIds).size===x.sourceIds.length);
const section="أسماء الصور", sourceName="الاسم عربي من الملف", siteName="الاسم عربي من الموقع",
  siteId="معرف الصنف من الموقع", state="حالة السجل";
const aliases: Record<string,string> = {
  "ملغ":"مجم","مليغرام":"مجم","مليجرام":"مجم","ملجم":"مجم","mg":"مجم",
  "غرام":"جم","جرام":"جم","غ":"جم","g":"جم","ml":"مل","مليلتر":"مل","ميكروغرام":"مكجم","mcg":"مكجم",
  "حبوب":"اقراص","قرص":"اقراص","اقراص":"اقراص","كبسوله":"كبسولات","كبسولة":"كبسولات",
};
export function easyImageNameKey(name:string):string {
  return name.normalize("NFC").toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,"")
    .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي")
    .replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660))
    .replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6f0))
    .replace(/٫/g,".").replace(/٪/g,"%").replace(/／/g,"/")
    .replace(/(?<=[0-9])\s+(?=[./][0-9])/g,"").replace(/(?<=[0-9][./])\s+(?=[0-9])/g,"")
    .replace(/(?<=\p{L})[-‐‑–](?=\p{L})/gu," ")
    .replace(/(?<=\d)(?=\p{L})|(?<=\p{L})(?=\d)/gu," ")
    .trim().split(/\s+/u).map(x=>Object.hasOwn(aliases,x)?aliases[x]:x).join(" ");
}
const simple = (key:string) => /[ء-ي]{2}/.test(key)
  && /(?:^|\s)\d+(?:\.\d+)?(?:\s(?:مجم|جم|مل|مكجم)(?:\s|$)|\s*%(?:\s|$))/.test(key)
  && /(?:^|\s)(?:اقراص|كبسولات|شراب|كريم|مرهم|جل|قطره|قطرة|بخاخ|فيال|امبول|محلول|معلق|تحاميل)(?:\s|$)/.test(key)
  && !/[?؟~]/.test(key);
type Card={id:number;name:string};
export function easyImageCardIndex(cards:Card[]){
  const keys=new Map<string,Card|null>();
  for(const card of cards){
    const k=easyImageNameKey(card.name);
    if(simple(k))keys.set(k,keys.has(k)?null:card);
  }
  return keys;
}
export function easyImageMatch(name:unknown, keys:Map<string,Card|null>){
  if(typeof name!=="string")return undefined;
  const k=easyImageNameKey(name);
  return simple(k)?keys.get(k):undefined;
}
type SourceRow={source_id:string;position:number;payload:Record<string,unknown>;market_card_id:number|null};
export async function matchImageNamesEasy(pool:Pool,input:z.infer<typeof imageNameMatchSchema>){
 return transaction(pool,async db=>{
  await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await db.query("SET LOCAL lock_timeout='1200ms'");
  await db.query("SET LOCAL statement_timeout='3000ms'");
  if(input.expectedPreview) await db.query("SELECT pg_advisory_xact_lock(714390227)");
  const ids=input.sourceIds.slice().sort((a,b)=>a-b);
  const sources=await db.query("SELECT id FROM market_import_sources WHERE id=ANY($1::bigint[]) AND metadata->>'format'='image-filename-index'",[ids]);
  if(sources.rowCount!==ids.length)throw new HttpError(400,"image_match_source","المطابقة تخص فهارس أسماء الصور فقط");
  const rows=(await db.query<SourceRow>(
    "SELECT source_id,position,payload,market_card_id FROM market_import_rows WHERE source_id=ANY($1::bigint[]) AND section=$2 ORDER BY source_id,position",[ids,section])).rows;
  if(rows.length>15000)throw new HttpError(400,"image_match_limit","قسّم المصادر إلى مجموعتين");
  const catalog=(await db.query<Card>("SELECT id,name FROM medicine_market_cards WHERE kind='medicine' AND status='published' AND NOT archived")).rows;
  const choose=input.mode!=="easy"
    ? (()=>{const deeper=input.mode==="investigated";const index=buildImageAttributeIndex(catalog,deeper);return (name:unknown)=>matchImageAttributes(name,index,deeper);})()
    : (()=>{const index=easyImageCardIndex(catalog);return (name:unknown)=>easyImageMatch(name,index);})();
  const plan:{sourceId:number;position:number;cardId:number;name:string}[]=[];
  let already=0,ambiguous=0;
  const examples:{sourceId:number;position:number;source:string;target:string;cardId:number}[]=[];
  for(const row of rows){
    if(row.market_card_id!==null || [siteName,siteId,state].some(k=>row.payload[k]!=null)){already++;continue;}
    const label=row.payload[sourceName];
    const card=choose(label);
    if(card===null){ambiguous++;continue;}
    if(!card)continue;
    const sourceId=Number(row.source_id);
    plan.push({sourceId,position:row.position,cardId:card.id,name:card.name});
    if(examples.length<12) examples.push({sourceId,position:row.position,source:String(label),target:card.name,cardId:card.id});
  }
  const digest=createHash("sha256").update(JSON.stringify([input.mode,ids,rows.length,already,plan])).digest("hex");
  let saved=0;
  if(input.expectedPreview){
    if(input.expectedPreview!==digest)throw new HttpError(409,"image_match_preview_changed","تغيرت المعاينة؛ اعرضها من جديد");
    if(plan.length){
      const locked=await db.query("SELECT id FROM medicine_market_cards WHERE id=ANY($1::int[]) AND kind='medicine' AND status='published' AND NOT archived FOR SHARE",[[...new Set(plan.map(x=>x.cardId))]]);
      if(locked.rowCount!==new Set(plan.map(x=>x.cardId)).size)throw new HttpError(409,"image_match_cards_changed","تغيرت أصناف الوجهة");
      const update=await db.query(`UPDATE market_import_rows r SET market_card_id=x."cardId",
           payload=r.payload||jsonb_build_object($3::text,x.name,$4::text,x."cardId",$5::text,$6::text)
         FROM jsonb_to_recordset($1::jsonb) AS x("sourceId" bigint,position int,"cardId" int,name text)
         WHERE r.source_id=x."sourceId" AND r.position=x.position AND r.section=$2
           AND r.market_card_id IS NULL AND r.payload->>$3 IS NULL AND r.payload->>$4 IS NULL AND r.payload->>$5 IS NULL`,
         [JSON.stringify(plan),section,siteName,siteId,state,input.mode==="investigated"?"مطابق بعد التحري":input.mode==="attributes"?"مطابق الاسم والقوة والشكل":"مطابق واضح"]);
      saved=update.rowCount??0;
      if(saved!==plan.length)throw new HttpError(409,"image_match_rows_changed","تغير بعض السجلات؛ لم تُحفظ الدفعة");
    }
  }
  return {mode:input.mode,sourceIds:ids,scanned:rows.length,already,matched:plan.length,ambiguous,remaining:rows.length-already-plan.length,
   digest,preview:!input.expectedPreview,saved,examples};
 });
}
