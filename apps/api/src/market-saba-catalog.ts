import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

/** Saba Pharma catalogue 18 August 2024, four PDF pages by distribution sector.
 * Each row: [page,Arabic product name, listed price, WHOLESALE bonus percent,
 * packaging unit, source row number, right|left table half].
 * Never use the separate pharmacy bonus column in this import.
 */
const rowSchema=z.tuple([
 z.number().int().min(1).max(4),
 z.string().trim().min(2).max(300),
 z.number().int().nonnegative().max(10000000),
 z.number().int().min(0).max(100),
 z.string().trim().max(40),
 z.number().int().min(1).max(99),
 z.enum(["right","left"]),
]);
export const sabaImportSchema=z.object({
 idempotencyKey:z.string().uuid(),
 sourceSha256:z.literal("211777e825a4e691f65b55a87673033c875c4b574d41257e37ba69a3ce093d99"),
 encoded:z.string().min(200).max(14000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export type SabaImportInput=z.infer<typeof sabaImportSchema>;
type Row=z.infer<typeof rowSchema>;
type Card={id:number;name:string;normalized_name:string;data:Record<string,unknown>;revision:number};
const sectorByPage:Record<number,{name:string;agentId:number}>={
 1:{name:"سبأ",agentId:1314},
 2:{name:"السعيدة",agentId:31206},
 3:{name:"الحديثة",agentId:31207},
 4:{name:"الوطنية",agentId:31208},
};
export function unpackSabaRows(input:SabaImportInput){
 const bytes=Buffer.from(input.encoded,"base64");
 if(bytes.length>15000||bytes.length<100)throw Error("invalid_saba_payload");
 const decompressed=gunzipSync(bytes,{maxOutputLength:100000});
 const source=z.array(rowSchema).min(1).max(350).parse(JSON.parse(decompressed.toString("utf8")));
 if(source.length!==281||
    [1,2,3,4].some(page=>source.filter(row=>row[0]===page).length!==[84,83,88,26][page-1]))
   throw Error("invalid_saba_row_counts");
 const fingerprint=createHash("sha256").update(decompressed).digest("hex");
 return {rows:source,fingerprint};
}
const norm=(s:string)=>s.normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/g,"")
 .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي").replace(/\s+/g," ").trim().toLowerCase();
function productKey(s:string):string{
 return norm(s)
   .replace(/[٠-٩]/g,c=>String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
   .replace(/(\d)[\s]*[*×xX][\s]*(\d)/g,"$1x$2")
   .replace(/ملجم|ملليجرام|ملج\b/g," ملج ")
   .replace(/ميكروجرام/g," مكج ")
   .replace(/قرص|اقراص|اقراصا/g," اقراص ")
   .replace(/كبسول(?:ة|ات)?/g," كبسول ")
   .replace(/قطر(?:ة|ات)?/g," قطرة ")
   .replace(/اكياس|اكياسا|كيس/g," كيس ")
   .replace(/بودر|بودرة/g," بودرة ")
   .replace(/شراب|سيرب/g," شراب ")
   .replace(/بالحرفي/g,"")
   .replace(/[()[\]{}.,،;:_\-ـ|/\\+%]/g," ")
   .replace(/\b(?:باكت|بكت|باكيت|عبوه|عبوة|زجاجة|علبة)\b/g," ")
   .replace(/\s+/g," ").trim();
}
function key(card:Card){return productKey(card.name);}
type Offer={sector:string;agentId:number;page:number;row:number;side:string;sourceName:string;unit:string;price:string;wholesaleBonus:string;documentDate:string};
const safeArray=(v:unknown):Offer[]=>
 Array.isArray(v)?v.filter((x):x is Offer=>!!x&&typeof x==="object"&&typeof x.sector==="string"&&typeof x.sourceName==="string"):[];
function addOffer(current:Offer[],next:Offer):Offer[]{
 const i=current.findIndex(x=>x.sector===next.sector && x.page===next.page && x.row===next.row && x.side===next.side);
 if(i>=0)return current;
 return [...current,next];
}
async function lockAndRead(db:PoolClient,id:number):Promise<Card|undefined>{
 return (await db.query<Card>("SELECT id,name,normalized_name,data,revision FROM medicine_market_cards WHERE id=$1 AND kind='medicine' AND status='published' AND NOT archived FOR UPDATE",[id])).rows[0];
}
export async function importSabaCatalog(pool:Pool,input:SabaImportInput,actorId:number,actorName:string):Promise<void>{
 const db=await pool.connect();
 let transaction=false;
 try{
   await db.query("BEGIN");transaction=true;
   await db.query("SET LOCAL statement_timeout='240s'");
   await db.query("SELECT pg_advisory_xact_lock(714390221)");
   // We never merge by approximate name: strengths, forms and pack counts must agree.
   const all=await db.query<Card>(
    "SELECT id,name,normalized_name,data,revision FROM medicine_market_cards WHERE kind='medicine' AND status='published' AND NOT archived");
   const byKey=new Map<string,Card[]>();
   for(const card of all.rows){
     const k=key(card);
     if(!k)continue;
     const candidates=byKey.get(k)??[];
     candidates.push(card);byKey.set(k,candidates);
   }
   const {rows}=unpackSabaRows(input);
   const report:Array<{page:number;sourceName:string;reason:string;candidateIds?:number[]} >=[];
   let matched=0,inserted=0,changed=0,skipped=0,duplicatedOffers=0,pricePreserved=0,agentPreserved=0;
   for(const [page,originalName,price,wholesale,unit,rowNum,side] of rows){
     const sector=sectorByPage[page]!;
     const name=originalName.normalize("NFKC").replace(/\s+/g," ").trim();
     const offer:Offer={sector:sector.name,agentId:sector.agentId,page,row:rowNum,side,
       sourceName:name,unit,price:String(price),wholesaleBonus:String(wholesale),documentDate:"2024-08-18"};
     const pkey=productKey(name);
     if(pkey.length<4){skipped++;report.push({page,sourceName:name,reason:"invalid_short_name"});continue;}
     const candidates=byKey.get(pkey)??[];
     if(candidates.length>1){
       skipped++;report.push({page,sourceName:name,reason:"ambiguous_name",candidateIds:candidates.map(x=>x.id)});continue;
     }
     let card=candidates[0];
     if(card){
       const current=await lockAndRead(db,card.id);
       if(!current){skipped++;report.push({page,sourceName:name,reason:"changed_during_import"});continue;}
       card=current;
       matched++;
       const previous=card.data??{};
       const offers=safeArray(previous.saba2024Offers);
       const updatedOffers=addOffer(offers,offer);
       if(updatedOffers.length===offers.length){duplicatedOffers++;continue;}
       const updated:Record<string,unknown>={...previous,saba2024Offers:updatedOffers,
         saba2024CatalogDate:"2024-08-18",saba2024CatalogFile:"18-08-2024.pdf"};
       const existingAgent=Number(previous.agentId??0);
       if(!existingAgent)updated.agentId=sector.agentId;
       else if(existingAgent!==sector.agentId)agentPreserved++;
       // Do not replace more recent or independently sourced data.
       if(previous.purchasePrice===undefined||previous.purchasePrice===null||previous.purchasePrice==="")
         updated.purchasePrice=String(price);
       else if(String(previous.purchasePrice)!==String(price))pricePreserved++;
       if(previous.agentBonus===undefined||previous.agentBonus===null||previous.agentBonus==="")
         updated.agentBonus=String(wholesale);
       await db.query(
         "UPDATE medicine_market_cards SET data=$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1",
         [card.id,JSON.stringify(updated)]);
       card.data=updated;card.revision++;changed++;
     }else{
       const data={
         agentId:sector.agentId,
         purchasePrice:String(price),
         agentBonus:String(wholesale),
         saba2024Offers:[offer],
         saba2024CatalogDate:"2024-08-18",
         saba2024CatalogFile:"18-08-2024.pdf",
       };
       const newId=randomUUID();
       // DB unique name constraint is authoritative; no name is silently replaced.
       const insertedCard=await db.query<Card>(
         "INSERT INTO medicine_market_cards(kind,name,normalized_name,data,status,created_by,idempotency_key)"+
         " VALUES('medicine',$1,$2,$3::jsonb,'published',$4,$5)"+
         " ON CONFLICT DO NOTHING RETURNING id,name,normalized_name,data,revision",
         [name,norm(name),JSON.stringify(data),actorId,newId]);
       if(!insertedCard.rowCount){
         skipped++;report.push({page,sourceName:name,reason:"unique_name_exists"});continue;
       }
       card=insertedCard.rows[0]!;
       byKey.set(pkey,[card]);inserted++;
     }
   }
   await db.query(
     "UPDATE market_saba_catalog_runs SET status='complete',total=$2,matched=$3,inserted=$4,changed=$5,"+
     " skipped=$6,duplicated_offers=$7,price_preserved=$8,agent_preserved=$9,report=$10::jsonb,error_code=NULL,updated_at=now() WHERE id=$1",
     [input.idempotencyKey,rows.length,matched,inserted,changed,skipped,duplicatedOffers,pricePreserved,agentPreserved,JSON.stringify({issues:report})]);
   await db.query(
     "INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)"+
     " VALUES($1,$2,'public',NULL,'medicine-market.import_saba_2024','medicine-market',NULL,NULL,$3::jsonb)",
     [actorId,actorName,JSON.stringify({runId:input.idempotencyKey,sourceSha256:input.sourceSha256,total:rows.length,matched,inserted,changed,skipped,duplicatedOffers,pricePreserved,agentPreserved})]);
   await db.query("COMMIT");transaction=false;
 }catch(err){
   if(transaction){try{await db.query("ROLLBACK");}catch{}}
   const message=err instanceof Error?err.message:"internal";
   try{await pool.query("UPDATE market_saba_catalog_runs SET status='failed',error_code=$2,updated_at=now() WHERE id=$1 AND status='running'",[input.idempotencyKey,message.slice(0,200)]);}catch{}
   console.error("MARKET_SABA_CATALOG_FAILED",message);
 }finally{db.release();}
}
