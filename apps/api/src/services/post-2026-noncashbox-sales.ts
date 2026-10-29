import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import type { Request } from "express";
import { transaction } from "../db.ts";
import { companyAccess, currentActor, ownerOnly } from "../policies/access.ts";
import { assertRequestPagesEnabled } from "./pages.ts";
import { batchSchema } from "../routes-transaction-import-schemas.ts";
import { importTransactionBatch } from "./transaction-import.ts";
import { moneyString, moneyUnits, quantum } from "./finance.ts";

const COMPANY=2;
const SOURCE="dar-aldawa-legacy-2026-10";
const ENV="ALRAESY_POST_2026_NONCASHBOX_SALES_494";
type Staged={source_id:string;posting_date:string;status:string;source_document:any;request_hash:string};
function sorted(v:unknown):unknown {
 if(Array.isArray(v))return v.map(sorted);
 if(v!==null&&typeof v==="object")
  return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,sorted(x)]));
 return v;
}
function digest(v:unknown){return createHash("sha256").update(JSON.stringify(sorted(v))).digest("hex");}
function uuid(v:unknown){
 const b=createHash("sha256").update(JSON.stringify(v)).digest();
 b[6]=(b[6]!&15)|0x80;b[8]=(b[8]!&63)|0x80;
 const s=b.subarray(0,16).toString("hex");
 return s.slice(0,8)+"-"+s.slice(8,12)+"-"+s.slice(12,16)+"-"+s.slice(16,20)+"-"+s.slice(20);
}
function request(user:User,resource:string,method:string):Request{
 const path="/companies/2/"+resource;
 return {auth:{user},params:{companyId:"2"},method,path,originalUrl:path,body:{}} as unknown as Request;
}
const TARGET_SQL=
 "SELECT s.source_id FROM legacy_import_staging s "+
 "JOIN accounts a ON a.company_id=s.company_id AND a.id=(s.source_document->'payload'->>'counterpartyAccountId')::integer "+
 "WHERE s.company_id=$1 AND s.source_system=$2 AND s.source_kind='invoice' "+
 "AND s.posting_date>=DATE '2026-01-01' AND s.posting_date<DATE '2027-01-01' "+
 "AND s.source_document->'payload'->>'kind'='sale' "+
 "AND a.name NOT LIKE '%صندوق%' "+
 "AND NOT EXISTS (SELECT 1 FROM transaction_source_imports p "+
 "WHERE p.company_id=s.company_id AND p.source_kind=s.source_kind AND p.source_id=s.source_id) "+
 "ORDER BY s.posting_date,s.source_id";
/**
 * An explicitly authorized bounded, restart-safe import. Does not resume any
 * paused global worker. Never posts an item from a cashbox (any صندوق).
 * Original staging documents/hashes remain immutable for evidentiary recovery.
 */
export async function post2026NoncashboxSalesOnce(pool:Pool):Promise<void>{
 if(process.env[ENV]!=="1")return;
 const candidate=await pool.query<{source_id:string}>(TARGET_SQL,[COMPANY,SOURCE]);
 if(candidate.rowCount!==494)throw new Error("2026 noncashbox sales scope drift; expected exactly 494, found "+candidate.rowCount);
 const busy=await pool.query("SELECT 1 FROM legacy_import_runs WHERE company_id=$1 AND status IN ('running','rebuilding') LIMIT 1",[COMPANY]);
 if(busy.rowCount)throw new Error("Another import run is active");
 let posted=0,failed=0,existing=0,convertedPrices=0;
 const failedIds:string[]=[];
 for(const item of candidate.rows){
  const id=item.source_id;
  const result=await transaction(pool,async client=>{
   await client.query("SELECT pg_advisory_xact_lock(hashtext('owner-2026-noncash-sales'),$1)",[COMPANY]);
   const user=await currentActor(client,{id:1} as User);
   ownerOnly(user);
   if(user.suspended)throw new Error("Owner account suspended");
   await companyAccess(client,user,COMPANY,undefined,true);
   const src=await client.query<Staged>(
     "SELECT s.source_id,s.status,s.posting_date::text AS posting_date,s.source_document,s.request_hash "+
     "FROM legacy_import_staging s JOIN accounts a "+
     "ON a.company_id=s.company_id AND a.id=(s.source_document->'payload'->>'counterpartyAccountId')::integer "+
     "WHERE s.company_id=$1 AND s.source_system=$2 AND s.source_kind='invoice' AND s.source_id=$3 "+
     "AND s.posting_date>=DATE '2026-01-01' AND s.posting_date<DATE '2027-01-01' "+
     "AND s.source_document->'payload'->>'kind'='sale' AND a.name NOT LIKE '%صندوق%' FOR UPDATE OF s",
     [COMPANY,SOURCE,id]);
   if(!src.rows[0])return "existing";
   const row=src.rows[0];
   const already=await client.query("SELECT 1 FROM transaction_source_imports WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2",[COMPANY,id]);
   if(already.rowCount)return "existing";
   const doc=row.source_document;
   if(doc?.type!=="invoice"||doc.sourceId!==id||doc.payload?.kind!=="sale"||
      doc.payload?.documentDate!==row.posting_date||digest(doc)!==row.request_hash)
     throw new Error("Immutable historical source mismatch: "+id);
   const currency=await client.query<{decimal_places:number}>(
    "SELECT decimal_places FROM company_currencies WHERE company_id=$1 AND id=$2 AND active",
    [COMPANY,doc.payload.currencyId]);
   if(!currency.rows[0])throw new Error("Historical currency unavailable");
   const q=quantum(currency.rows[0].decimal_places);
   let changed=false;
   const lines=doc.payload.lines.map((line:any)=>{
    if(line.unitPrice===undefined)return line;
    const units=moneyUnits(line.unitPrice);
    if(units<0n)throw new Error("Negative source unit price: "+id);
    const nearest=((units+q/2n)/q)*q;
    if(units===nearest)return line;
    changed=true;
    return {...line,unitPrice:moneyString(nearest)};
   });
   const description=changed ?
     (String(doc.payload.description)+" | أسعار المصدر مقربة إلى خانات العملة؛ الأصل محفوظ في جدول الاستيراد").slice(0,1000):
     doc.payload.description;
   const updated={...doc,payload:{...doc.payload,lines,description,
     idempotencyKey:changed?uuid(["2026-noncash-price-v1",id,row.request_hash]):doc.payload.idempotencyKey}};
   const check=batchSchema.safeParse({
     idempotencyKey:uuid(["2026-noncash-sales-batch-v1",id,row.request_hash]),
     sourceSystem:SOURCE,postingDate:row.posting_date,documents:[updated]});
   if(!check.success){
    const reason=check.error.issues.map(x=>x.path.join(".")+": "+x.message).join("; ").slice(0,850);
    await client.query("UPDATE legacy_import_staging SET status='failed',error_message=$3,updated_at=clock_timestamp() WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2",
      [COMPANY,id,"[owner-noncash-2026] "+reason]);
    return "failed";
   }
   const result=await importTransactionBatch(client,user,COMPANY,check.data,async()=>{
    await assertRequestPagesEnabled(client,request(user,"transaction-import/batch","POST"),true);
    for(const part of ["account-ledger","stock-balances","stock-movements"])
      await assertRequestPagesEnabled(client,request(user,part,"GET"),true);
   });
   if(result.imported.length===1||result.existing.length===1){
    await client.query("UPDATE legacy_import_staging SET status='completed',error_message=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2",[COMPANY,id]);
    return changed?"posted-rounded":"posted";
   }
   const failure=result.failed[0];
   await client.query("UPDATE legacy_import_staging SET status='failed',error_message=$3,updated_at=clock_timestamp() WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2",
      [COMPANY,id,("[owner-noncash-2026] "+failure?.code+": "+failure?.message).slice(0,1000)]);
   return "failed";
  });
  if(result==="posted"||result==="posted-rounded"){posted++;if(result==="posted-rounded")convertedPrices++;}
  else if(result==="existing")existing++;
  else{failed++;failedIds.push(id);}
  if((posted+failed+existing)%25===0)
   console.info("OWNER_NONCASH_SALES_2026_PROGRESS",{considered:posted+failed+existing,posted,failed,existing});
 }
 console.info("OWNER_NONCASH_SALES_2026_FINAL",{selected:candidate.rowCount,posted,failed,existing,convertedPrices,failedIds});
}