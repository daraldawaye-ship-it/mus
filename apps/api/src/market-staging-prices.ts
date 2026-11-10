import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { arabizeMarketName, normalizedArabicSearch } from "./market-arabic-names.ts";
import { HttpError } from "./errors.ts";

const priceEntry = z.object({
  position: z.number().int().min(2),
  cardId: z.number().int().positive().optional(),
  expectedPrice: z.string().nullable(),
  match: z.enum(["name","composition","new"]),
}).strict();
export const stagingPricesSchema = z.object({
  entries: z.array(priceEntry).min(1).max(200),
}).strict();
export const stagingPricesOperation = "POST /medicine-market/staging/:sourceId/apply-sale-prices";

type Entry = z.infer<typeof priceEntry>;
type Card = {id:number;name:string;data:Record<string,unknown>};
const sourceHash = "1a9458b501b5101f0359da0266e0c9900ad2a03d14af218e1f37c70fdc10f3cd";
const section = "ورقة1";
function titleCase(name:string){
  return name.replace(/[A-Za-z]+/g, word => word[0]!.toUpperCase()+word.slice(1).toLowerCase());
}

export async function applyStagingSalePrices(db:PoolClient,sourceId:number,entries:Entry[],actor:{id:number;displayName:string}){
  const verified = await db.query(
    "SELECT 1 FROM market_import_sources s JOIN market_import_jobs j ON j.id=s.job_id WHERE s.id=$1 AND s.sha256=$2 AND j.status='complete'",
    [sourceId,sourceHash]);
  if (!verified.rowCount) throw new HttpError(400,"invalid_source","العملية مخصصة لجدول عبدالسلام");
  await db.query("SELECT pg_advisory_xact_lock(714390235)");
  const positions = entries.map(e=>e.position);
  if (new Set(positions).size!==positions.length) throw new HttpError(400,"duplicate_position","سجل مكرر في الطلب");
  const rows = await db.query(
    `SELECT r.position,
      (SELECT jsonb_object_agg(c->>'column',CASE WHEN c->>'type'='f' THEN c->>'cached' ELSE c->>'value' END)
       FROM jsonb_array_elements(r.payload->'cells') c WHERE c->>'column' IN ('1','2','3','4','10')) AS cells
     FROM market_import_rows r WHERE source_id=$1 AND section=$2 AND position=ANY($3::integer[])`,
    [sourceId,section,positions]);
  const cellsByPosition = new Map(rows.rows.map(r=>[Number(r.position),r.cells]));
  const results:{position:number;status:string;cardId?:number;created?:boolean}[]=[];
  for (const entry of [...entries].sort((a,b)=>a.position-b.position)){
    const position = entry.position;
    const cells = cellsByPosition.get(position);
    const sourceName = String(cells?.["2"]??"").normalize("NFKC").replace(/\s+/g," ").trim();
    if (!sourceName || !cells?.["1"]) {results.push({position,status:"no_item"});continue;}
    const rawPrice = String(cells["4"]??cells["10"]??"").trim();
    if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(rawPrice)) {results.push({position,status:"invalid_price"});continue;}
    const price = rawPrice.includes(".") ? rawPrice.replace(/0+$/,"").replace(/\.$/,"") : rawPrice;
    const key = [sourceId,section,position];
    const old = (await db.query(
      "SELECT status,completed_fields,remaining_fields,card_refs,notes,revision FROM market_import_row_followups WHERE source_id=$1 AND section=$2 AND position=$3 FOR UPDATE",key)).rows[0];
    if (old?.completed_fields.includes("defaultSalePrice")) {
      results.push({position,status:"previously_priced",cardId:old.card_refs.find((x:{kind:string})=>x.kind==="medicine")?.id});continue;
    }
    const source = `عبدالسلام.xlsx، ورقة1، السطر ${position}، رقم الصنف ${cells["1"]}، الوحدة ${cells["3"]??""}`;
    let card:Card|undefined;
    let created=false;
    if(entry.cardId){
      card=(await db.query<Card>("SELECT id,name,data FROM medicine_market_cards WHERE id=$1 AND kind='medicine' AND status='published' AND NOT archived FOR UPDATE",[entry.cardId])).rows[0];
      if(!card){results.push({position,status:"card_changed"});continue;}
    } else {
      if(entry.match!=="new") throw new HttpError(400,"missing_card","معرف الكرت مطلوب للمطابقة");
      const raw=sourceName.replace(/^[.;،؛]+/u,"").trim();
      const name=arabizeMarketName(raw);
      if(!name || name.length>300){results.push({position,status:"invalid_name"});continue;}
      const normalized=normalizedArabicSearch(name);
      const exact=(await db.query<Card & {archived:boolean;status:string}>(
        "SELECT id,name,data,archived,status FROM medicine_market_cards WHERE kind='medicine' AND normalized_name=$1 AND status<>'rejected' FOR UPDATE",[normalized])).rows[0];
      if(exact && (exact.archived || exact.status!=="published")) {results.push({position,status:"inactive_duplicate"});continue;}
      card=exact;
      if(!card){
        const token=randomUUID();
        const initial=/[a-z]/i.test(raw)?{englishName:titleCase(raw)}:{};
        card=(await db.query<Card>(
          "INSERT INTO medicine_market_cards(kind,name,normalized_name,data,status,created_by,idempotency_key) VALUES('medicine',$1,$2,$3,'published',$4,$5) ON CONFLICT DO NOTHING RETURNING id,name,data",
          [name,normalized,JSON.stringify(initial),actor.id,token])).rows[0];
        if(!card){results.push({position,status:"card_changed"});continue;}
        created=true;
        await db.query("INSERT INTO medicine_market_contributions(card_id,field_key,previous_value,proposed_value,source,author_id,idempotency_key,published,status,reviewer_id,reviewed_at,reason) VALUES($1,'name','null'::jsonb,$2,$3,$4,$5,true,'approved',$4,now(),'إدخال المالك من جدول عبدالسلام')",
          [card.id,JSON.stringify(name),source,actor.id,token]);
      }
    }
    const previous=card.data.defaultSalePrice??null;
    if(previous!==price){
      if(previous!==entry.expectedPrice){results.push({position,status:"price_changed",cardId:card.id});continue;}
      const applied=await db.query("UPDATE medicine_market_cards SET data=jsonb_set(data,'{defaultSalePrice}',to_jsonb($2::text)),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING data->>'defaultSalePrice' AS price",[card.id,price]);
      if(applied.rows[0]?.price!==price) throw new Error("price_readback_failed");
      await db.query("INSERT INTO medicine_market_contributions(card_id,field_key,previous_value,proposed_value,source,author_id,idempotency_key,published,status,reviewer_id,reviewed_at,reason) VALUES($1,'defaultSalePrice',$2,$3,$4,$5,$6,true,'approved',$5,now(),'تسعير المالك من جدول عبدالسلام')",
        [card.id,JSON.stringify(previous),JSON.stringify(price),source,actor.id,randomUUID()]);
    }
    const completed=[...new Set<string>([...(old?.completed_fields??[]),"defaultSalePrice"])];
    const remaining=(old?.remaining_fields??[]).filter((f:string)=>f!=="defaultSalePrice");
    const refs=[...(old?.card_refs??[])];
    if(!refs.some(ref=>ref.kind==="medicine" && ref.id===card!.id)) refs.push({kind:"medicine",id:card.id});
    const status=remaining.length?"partial":"complete";
    const notes=[old?.notes,`${created?"إضافة":entry.match==="composition"?"مطابقة بالتركيب والشكل":"مطابقة بالاسم"}، سعر البيع الافتراضي ${price}، الوحدة ${cells["3"]??""}.`].filter(Boolean).join("\n");
    const revision=Number(old?.revision??0)+1;
    await db.query(`INSERT INTO market_import_row_followups(source_id,section,position,status,completed_fields,remaining_fields,card_refs,notes,revision,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(source_id,section,position) DO UPDATE SET status=EXCLUDED.status,completed_fields=EXCLUDED.completed_fields,
      remaining_fields=EXCLUDED.remaining_fields,card_refs=EXCLUDED.card_refs,notes=EXCLUDED.notes,revision=EXCLUDED.revision,updated_by=EXCLUDED.updated_by,updated_at=now()
      WHERE market_import_row_followups.revision=EXCLUDED.revision-1 RETURNING revision`,[...key,status,completed,remaining,JSON.stringify(refs),notes,revision,actor.id]).then(r=>{if(!r.rowCount)throw new HttpError(409,"followup_changed","تغيرت متابعة السجل");});
    await db.query("INSERT INTO market_import_row_followup_history(source_id,section,position,revision,old_value,new_value,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [...key,revision,old?JSON.stringify(old):null,JSON.stringify({status,completedFields:completed,remainingFields:remaining,cardRefs:refs,notes}),actor.id]);
    results.push({position,status,cardId:card.id,created});
  }
  await db.query("INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value) VALUES($1,$2,'public',NULL,'medicine-market.staging-sale-prices','medicine-market',NULL,NULL,$3)",
    [actor.id,actor.displayName,JSON.stringify({sourceId,positions,completed:results.filter(r=>r.status==="complete").length})]);
  return {items:results};
}
