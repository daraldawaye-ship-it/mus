import {randomUUID} from "node:crypto";
import {Router} from "express";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {actor,handler,parse,id} from "../http.ts";
import {ownerOnly} from "../policies/access.ts";
import {HttpError} from "../errors.ts";

export const productLinkBatchSchema=z.object({
  after:z.number().int().min(0).default(0),
  limit:z.number().int().min(1).max(60).default(40),
  createMissing:z.boolean().default(true),
  dryRun:z.boolean().default(false),
}).strict();
type Cell={column:number;value:unknown};
type ImportRow={position:number;payload:{cells?:Cell[]};card_refs:unknown;market_card_id:number|null};
type MarketCard={id:number;normalized_name:string;data:Record<string,unknown>};
const SOURCE_FILENAME="Priced-Products-(21-10-2021).xls";
const SECTION="All Pricing";
const norm=(s:string)=>s.normalize("NFKC")
  .replace(/[\u064B-\u065F\u0670\u0640]/g,"").replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي")
  .replace(/\s+/g," ").trim().toLowerCase();
function clean(value:unknown){
  return (typeof value==="string"?value:typeof value==="number"?String(value):"")
    .normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();
}
function cell(row:ImportRow,number:number){
  return clean((row.payload?.cells??[]).find(x=>Number(x.column)===number)?.value);
}
function makeProduct(row:ImportRow){
  const trade=cell(row,4),form=cell(row,5),pack=cell(row,7);
  if(!trade||trade.length<3||!/[a-z\u0600-\u06FF]/i.test(trade))return null;
  const parts=[trade];
  const formWords=/\b(?:tablets?|tabs?|capsules?|caps?|syrup|solutions?|drops?|injections?|vials?|ampoules?|cream|ointments?|gels?|sprays?|powder|infusions?|suppositor(?:y|ies)|suspensions?|patch(?:es)?)\b/i;
  if(form && !formWords.test(trade) && !norm(trade).includes(norm(form)))parts.push(form);
  if(pack && !norm(parts.join(" ")).includes(norm(pack)))parts.push(pack);
  const name=parts.join(" ").replace(/\s+/g," ").trim();
  const key=norm(name),baseKey=norm(trade);
  if(name.length>300||key.length>300||!key||!baseKey)return null;
  return {name,key,baseKey};
}
function soleMedicineRef(refs:unknown):number|null {
  if(!Array.isArray(refs))return null;
  const matches=refs.filter(x=>x && typeof x==="object" && x.kind==="medicine"
    && Number.isInteger(x.id) && x.id>0).map(x=>x.id as number);
  return matches.length===1?matches[0]!:null;
}
async function sourceReady(db:PoolClient|Pool,sourceId:number){
  const found=await db.query("SELECT filename FROM market_import_sources WHERE id=$1",[sourceId]);
  if(!found.rowCount || found.rows[0].filename!==SOURCE_FILENAME)
    throw new HttpError(404,"product_source_not_found","هذا المسار مخصص لجدول المنتجات المستورد فقط");
}
async function existing(db:PoolClient,key:string):Promise<MarketCard|null> {
  const found=await db.query(
    "SELECT id,normalized_name,data FROM medicine_market_cards WHERE kind='medicine' AND status='published' AND NOT archived AND normalized_name=$1 ORDER BY id LIMIT 2",
    [key]);
  return found.rows.length===1?found.rows[0] as MarketCard:null;
}
async function sameBrandVariants(db:PoolClient,baseKey:string){
  // If another older card with the same trade prefix exists but differs in
  // pack/form, don't silently create a possible duplicate. Flag for review.
  const row=await db.query(
    "SELECT id,normalized_name,data->>'importSourceId' AS source FROM medicine_market_cards WHERE kind='medicine' AND status='published' AND NOT archived AND (normalized_name=$1 OR left(normalized_name,length($1)+1)=$1||' ') ORDER BY id LIMIT 12",
    [baseKey]);
  return row.rows as {id:number;normalized_name:string;source:string|null}[];
}
async function linkRows(pool:Pool,sourceId:number,input:z.infer<typeof productLinkBatchSchema>,
 user:{id:number;displayName:string}) {
  const db=await pool.connect();
  let began=false;
  try {
    await db.query("BEGIN");began=true;
    await db.query("SET LOCAL statement_timeout='4s'");
    await db.query("SET LOCAL lock_timeout='600ms'");
    const lock=await db.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
      ["market-product-links:"+sourceId]);
    if(!lock.rows[0]?.locked)throw new HttpError(409,"product_link_busy","دفعة ربط أخرى تعمل الآن");
    await sourceReady(db,sourceId);
    const rows=await db.query<ImportRow>(
      "SELECT r.position,r.payload,r.market_card_id,COALESCE(f.card_refs,'[]'::jsonb) AS card_refs FROM market_import_rows r LEFT JOIN market_import_row_followups f ON f.source_id=r.source_id AND f.section=r.section AND f.position=r.position WHERE r.source_id=$1 AND r.section=$2 AND r.position>$3 ORDER BY r.position LIMIT $4",
      [sourceId,SECTION,input.after,input.limit]);
    const result={sourceId,section:SECTION,after:input.after,nextAfter:input.after,
      scanned:rows.rows.length,alreadyLinked:0,matched:0,created:0,unresolved:0,
      matchExamples:[] as {position:number;marketCardId:number}[],
      unresolvedExamples:[] as {position:number;reason:string}[],
      dryRun:input.dryRun,hasMore:false};
    const candidateCache=new Map<string,MarketCard|null>();
    const variantsCache=new Map<string,Awaited<ReturnType<typeof sameBrandVariants>>>();
    if(!input.dryRun && rows.rows.some(r=>r.position>1 && !r.market_card_id)) {
      await db.query("INSERT INTO users(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name WHERE users.display_name IS DISTINCT FROM EXCLUDED.display_name",
        [user.id,user.displayName]);
    }
    for(const row of rows.rows){
      result.nextAfter=row.position;
      if(row.position===1){result.unresolved++;continue;}
      if(row.market_card_id){result.alreadyLinked++;continue;}
      const product=makeProduct(row);
      if(!product){
        result.unresolved++;
        if(result.unresolvedExamples.length<12)result.unresolvedExamples.push({position:row.position,reason:"missing_or_invalid_trade_name"});
        continue;
      }
      const known=soleMedicineRef(row.card_refs);
      let card:MarketCard|null=null;
      if(known) {
        const found=await db.query<MarketCard>(
          "SELECT id,normalized_name,data FROM medicine_market_cards WHERE id=$1 AND kind='medicine' AND status='published' AND NOT archived",[known]);
        card=found.rows[0]??null;
      }
      if(!card){
        if(!candidateCache.has(product.key))candidateCache.set(product.key,await existing(db,product.key));
        card=candidateCache.get(product.key)??null;
      }
      if(!card){
        if(!candidateCache.has(product.baseKey))candidateCache.set(product.baseKey,await existing(db,product.baseKey));
        // Only use the unqualified name if this source row has no differing
        // pack/form. Otherwise the base card's actual variant is uncertain.
        if(product.key===product.baseKey)card=candidateCache.get(product.baseKey)??null;
      }
      if(card){
        result.matched++;
        if(!input.dryRun){
          await db.query("UPDATE market_import_rows SET market_card_id=$1 WHERE source_id=$2 AND section=$3 AND position=$4 AND market_card_id IS NULL",
            [card.id,sourceId,SECTION,row.position]);
        }
        if(result.matchExamples.length<12)result.matchExamples.push({position:row.position,marketCardId:card.id});
        continue;
      }
      if(!variantsCache.has(product.baseKey))
        variantsCache.set(product.baseKey,await sameBrandVariants(db,product.baseKey));
      const near=variantsCache.get(product.baseKey)??[];
      if(near.some(v=>v.source!==String(sourceId))){
        result.unresolved++;
        if(result.unresolvedExamples.length<12)result.unresolvedExamples.push({position:row.position,reason:"possible_existing_variant"});
        continue;
      }
      if(!input.createMissing){
        result.unresolved++;
        if(result.unresolvedExamples.length<12)result.unresolvedExamples.push({position:row.position,reason:"missing_card_creation_disabled"});
        continue;
      }
      if(input.dryRun){
        result.created++; // candidate only in dryRun; no card exists yet
        continue;
      }
      const inserted=await db.query<MarketCard>(
        "INSERT INTO medicine_market_cards(kind,name,normalized_name,data,status,created_by,idempotency_key) VALUES('medicine',$1,$2,$3::jsonb,'published',$4,$5::uuid) ON CONFLICT DO NOTHING RETURNING id,normalized_name,data",
        [product.name,product.key,JSON.stringify({englishName:product.name,importSourceId:sourceId,importSourcePosition:row.position}),user.id,randomUUID()]);
      if(inserted.rows.length){
        card=inserted.rows[0]!;
        await db.query(
          "INSERT INTO medicine_market_contributions(card_id,field_key,previous_value,proposed_value,source,author_id,idempotency_key,published,status,reviewer_id,reviewed_at,reason) VALUES($1,'name','null'::jsonb,$2::jsonb,$3,$4,$5::uuid,true,'approved',$4,now(),$6)",
          [card.id,JSON.stringify(product.name),"Priced-Products-(21-10-2021).xls",user.id,randomUUID(),"اسم من جدول المنتجات؛ اعتماد المالك، دون ترحيل الأسعار أو بقية البيانات"]);
        result.created++;
      }else{
        card=await existing(db,product.key);
        if(!card){
          result.unresolved++;
          if(result.unresolvedExamples.length<12)result.unresolvedExamples.push({position:row.position,reason:"concurrent_name_conflict"});
          continue;
        }
        result.matched++;
      }
      candidateCache.set(product.key,card);
      const v=variantsCache.get(product.baseKey)??[];
      v.push({id:card.id,normalized_name:card.normalized_name,source:String(sourceId)});
      if(!input.dryRun) {
        await db.query("UPDATE market_import_rows SET market_card_id=$1 WHERE source_id=$2 AND section=$3 AND position=$4 AND market_card_id IS NULL",
          [card.id,sourceId,SECTION,row.position]);
      }
      if(result.matchExamples.length<12)result.matchExamples.push({position:row.position,marketCardId:card.id});
    }
    const more=await db.query("SELECT EXISTS(SELECT 1 FROM market_import_rows WHERE source_id=$1 AND section=$2 AND position>$3) AS more",
      [sourceId,SECTION,result.nextAfter]);
    result.hasMore=Boolean(more.rows[0]?.more);
    if(!input.dryRun&&(result.matched||result.created)){
      await db.query("INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value) VALUES($1,$2,'public',NULL,'medicine-market.product_id_link','medicine-market',NULL,NULL,$3::jsonb)",
        [user.id,user.displayName,JSON.stringify({sourceId,after:input.after,nextAfter:result.nextAfter,scanned:result.scanned,matched:result.matched,created:result.created,unresolved:result.unresolved})]);
    }
    await db.query(input.dryRun?"ROLLBACK":"COMMIT");began=false;
    return result;
  }catch(error){
    if(began)await db.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally{db.release();}
}
export function productMarketLinkRoutes(pool:Pool):Router {
  const router=Router();
  const owner=(req:Parameters<typeof actor>[0])=>{
    const user=actor(req);ownerOnly(user);
    if(user.archived||user.suspended)throw new HttpError(403,"forbidden","غير مخول");
    return user;
  };
  router.get("/:sourceId/product-link-status",handler(async(req,res)=>{
    owner(req);
    const sourceId=id(req.params.sourceId);
    await sourceReady(pool,sourceId);
    const response=await pool.query(
      "SELECT count(*)::int AS total,count(*) FILTER (WHERE position>1)::int AS product_rows,count(*) FILTER (WHERE position>1 AND market_card_id IS NOT NULL)::int AS linked,count(*) FILTER (WHERE position>1 AND market_card_id IS NULL)::int AS unlinked,max(position)::int AS last_position FROM market_import_rows WHERE source_id=$1 AND section=$2",
      [sourceId,SECTION]);
    res.json({sourceId,section:SECTION,...response.rows[0]});
  }));
  router.post("/:sourceId/link-product-ids",handler(async(req,res)=>{
    const user=owner(req);
    const sourceId=id(req.params.sourceId);
    const input=parse(productLinkBatchSchema,req.body);
    res.json(await linkRows(pool,sourceId,input,user));
  }));
  return router;
}
