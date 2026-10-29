import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { transaction } from "../db.ts";
import { companyAccess, currentActor, ownerOnly } from "../policies/access.ts";
import { batchSchema } from "../routes-transaction-import-schemas.ts";
import { importTransactionBatch } from "./transaction-import.ts";
import { assertRequestPagesEnabled } from "./pages.ts";
import { moneyUnits, moneyString } from "./finance.ts";
import type { Request } from "express";

const COMPANY=2;
const SOURCE="dar-aldawa-legacy-2026-10";
const FLAG="ALRAESY_POST_2026_NONMARKET_PURCHASES_88";
const SCALE=1_000_000n;
type Row={source_id:string;posting_date:string;source_document:any;request_hash:string};
type Line={itemId:number;unit:1|2|3;quantity:string;unitPrice?:string;originalLineId:number|null};
type Factor={id:number;factor2:number;factor3:number;unit2_name:string;unit3_name:string};
function uuid(value:unknown):string{
 const b=createHash("sha256").update(JSON.stringify(value)).digest();
 b[6]=(b[6]!&15)|0x80;b[8]=(b[8]!&63)|0x80;
 const s=b.subarray(0,16).toString("hex");
 return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join("-");
}
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value!==null&&typeof value==="object")return Object.fromEntries(
  Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
 return value;
}
function fingerprint(value:unknown):string{return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");}
const abs=(n:bigint)=>n<0n?-n:n;
function convert(line:Line,item:Factor|undefined):Line{
 if(!item||line.unitPrice===undefined)throw new Error("missing_item_or_price");
 const qty=moneyUnits(line.quantity), price=moneyUnits(line.unitPrice);
 if(qty===0n||price<0n)throw new Error("invalid_source_quantity_or_price");
 const cents=10_000n;
 const round=(v:bigint)=>((v+cents/2n)/cents)*cents;
 if(qty%SCALE===0n)return {...line,quantity:(qty/SCALE).toString(),unitPrice:moneyString(round(price))};
 const choices:Array<{unit:2|3;factor:bigint}>=[];
 if(line.unit===1){
  if(item.factor2>1&&item.unit2_name.trim())choices.push({unit:2,factor:BigInt(item.factor2)});
  if(item.factor2>0&&item.factor3>1&&item.unit3_name.trim())
    choices.push({unit:3,factor:BigInt(item.factor2)*BigInt(item.factor3)});
 }else if(line.unit===2&&item.factor3>1&&item.unit3_name.trim())
   choices.push({unit:3,factor:BigInt(item.factor3)});
 for(const c of choices){
  const raw=qty*c.factor, n=(abs(raw)+SCALE/2n)/SCALE*(raw<0n?-1n:1n);
  if(n===0n||abs(raw-n*SCALE)>1_000n)continue;
  const np=round((abs(qty)*price+abs(n)*SCALE/2n)/(abs(n)*SCALE));
  // Financial deviation may not exceed 0.05 YER for the complete line.
  if(abs(abs(qty)*price-np*abs(n)*SCALE)>50_000_000_000n)continue;
  return {...line,unit:c.unit,quantity:n.toString(),unitPrice:moneyString(np)};
 }
 throw new Error("fractional_stock_not_representable_without_approximation");
}
function req(user:User,resource:string,method:string):Request{
 const path="/companies/2/"+resource;
 return {auth:{user},params:{companyId:"2"},method,path,originalUrl:path,body:{} } as unknown as Request;
}
export async function postNonmarketPurchases2026Once(pool:Pool):Promise<void>{
 if(process.env[FLAG]!=="1")return;
 const sql="SELECT s.source_id FROM legacy_import_staging s "+
 "WHERE s.company_id=$1 AND s.source_system=$2 AND s.source_kind='invoice' "+
 "AND s.posting_date>=DATE '2026-01-01' AND s.posting_date<DATE '2027-01-01' "+
 "AND s.source_document->'payload'->>'kind'='purchase' "+
 "AND s.source_document->'payload'->>'counterpartyAccountId'<>'338' "+
 "AND NOT EXISTS(SELECT 1 FROM transaction_source_imports m "+
 "WHERE m.company_id=s.company_id AND m.source_kind=s.source_kind AND m.source_id=s.source_id) "+
 "ORDER BY s.posting_date,s.source_id";
 const start=await pool.query<{source_id:string}>(sql,[COMPANY,SOURCE]);
 if(start.rows.length>88)throw new Error("Purchase scope greater than 88 authorized");
 const running=await pool.query("SELECT 1 FROM legacy_import_runs WHERE company_id=$1 AND status IN ('running','rebuilding') LIMIT 1",[COMPANY]);
 if(running.rowCount)throw new Error("An unrelated import is running");
 let posted=0,already=0,failed=0,unrepresentable=0,converted=0;
 const failures:string[]=[];
 for(const sourceId of start.rows.map(x=>x.source_id)){
  const result=await transaction(pool,async client=>{
   await client.query("SELECT pg_advisory_xact_lock(hashtext('owner-post-2026-nonmarket-88'),$1)",[COMPANY]);
   const user=await currentActor(client,{id:1} as User);
   ownerOnly(user);
   if(user.suspended)throw new Error("Owner suspended");
   await companyAccess(client,user,COMPANY,undefined,true);
   const found=await client.query<Row>(
     "SELECT source_id,posting_date::text AS posting_date,source_document,request_hash "+
     "FROM legacy_import_staging WHERE company_id=$1 AND source_system=$2 "+
     "AND source_kind='invoice' AND source_id=$3 AND posting_date>=DATE '2026-01-01' "+
     "AND posting_date<DATE '2027-01-01' AND source_document->'payload'->>'kind'='purchase' "+
     "AND source_document->'payload'->>'counterpartyAccountId'<>'338' FOR UPDATE",
     [COMPANY,SOURCE,sourceId]);
   const row=found.rows[0];
   if(!row)return "already";
   const existing=await client.query(
     "SELECT 1 FROM transaction_source_imports WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2",
     [COMPANY,sourceId]);
   if(existing.rowCount)return "already";
   const doc=row.source_document;
   if(doc?.type!=="invoice"||doc.sourceId!==sourceId||doc.payload?.kind!=="purchase"||
      doc.payload?.documentDate!==row.posting_date||fingerprint(doc)!==row.request_hash)
     throw new Error("Original staging hash / source identity mismatch");
   const lines=doc.payload.lines as Line[];
   const ids=[...new Set(lines.map(x=>x.itemId))];
   const items=await client.query<Factor>(
     "SELECT id,factor2,factor3,unit2_name,unit3_name FROM items WHERE company_id=$1 AND id=ANY($2::integer[])",
     [COMPANY,ids]);
   const byId=new Map(items.rows.map(x=>[x.id,x]));
   let fixed:Line[];
   try{fixed=lines.map(l=>convert(l,byId.get(l.itemId)));}
   catch(e){
     const msg=e instanceof Error?e.message:"unknown";
     await client.query("UPDATE legacy_import_staging SET status='failed',error_message=$3,updated_at=clock_timestamp() "+
       "WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2",
       [COMPANY,sourceId,"[owner-post-88] "+msg]);
     return "unrepresentable";
   }
   const changed=fixed.some((l,i)=>l.quantity!==lines[i]?.quantity||l.unit!==lines[i]?.unit||l.unitPrice!==lines[i]?.unitPrice);
   const note=changed?" | تحويل كمية المصدر إلى وحدة أصغر صحيحة؛ بيانات المصدر الأصلية محفوظة":"";
   const doc2={...doc,payload:{...doc.payload,
     idempotencyKey:changed?uuid(["owner-nonmarket2026",sourceId,row.request_hash]):doc.payload.idempotencyKey,
     description:(String(doc.payload.description)+note).slice(0,1000),lines:fixed}};
   const check=batchSchema.safeParse({idempotencyKey:uuid(["post-nonmarket2026",sourceId,row.request_hash]),
     sourceSystem:SOURCE,postingDate:row.posting_date,documents:[doc2]});
   if(!check.success){
     const msg=check.error.issues.map(x=>x.path.join(".")+": "+x.message).join("; ").slice(0,850);
     await client.query("UPDATE legacy_import_staging SET status='failed',error_message=$3,updated_at=clock_timestamp() "+
       "WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2",
       [COMPANY,sourceId,"[owner-post-88-validation] "+msg]);
     return "failed";
   }
   const postedResult=await importTransactionBatch(client,user,COMPANY,check.data,async()=>{
     await assertRequestPagesEnabled(client,req(user,"transaction-import/batch","POST"),true);
     for(const resource of ["account-ledger","stock-balances","stock-movements"])
       await assertRequestPagesEnabled(client,req(user,resource,"GET"),true);
   });
   if(postedResult.imported.length===1||postedResult.existing.length===1){
     await client.query("UPDATE legacy_import_staging SET status='completed',error_message=NULL,updated_at=clock_timestamp() "+
       "WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2",[COMPANY,sourceId]);
     return changed?"converted":"posted";
   }
   const err=postedResult.failed[0];
   await client.query("UPDATE legacy_import_staging SET status='failed',error_message=$3,updated_at=clock_timestamp() "+
     "WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2",
     [COMPANY,sourceId,("[owner-post-88] "+err?.code+": "+err?.message).slice(0,1000)]);
   return "failed";
  });
  if(result==="converted"||result==="posted"){posted++;if(result==="converted")converted++;}
  else if(result==="already")already++;
  else{failed++;failures.push(sourceId);if(result==="unrepresentable")unrepresentable++;}
  if((posted+failed+already)%10===0)
   console.info("OWNER_88_NONMARKET_PURCHASES_PROGRESS",{considered:posted+failed+already,posted,failed,already});
 }
 console.info("OWNER_88_NONMARKET_PURCHASES_FINAL",{
  selected:start.rows.length,posted,already,failed,unrepresentable,
  converted,failedIds:failures,marketExcluded:true});
}
