import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type { Pool } from "pg";
import { stagingBatchSchema } from "../routes-transaction-import-schemas.ts";

const ENV_KEY="ALRAESY_PRIVATE_OCT2026_SALES_STAGE_XLSX_URL";
const SOURCE_SYSTEM="dar-aldawa-legacy-2026-10";
const FILE_SHA256="b3a5c000ee52c45d51593a4150c2946b2f79aff8186f8212fd6697b44f5242e0";
const ROWS=22637, INVOICES=6584, COMPANY_ID=2, OWNER_ID=1;
const HEADERS=[
  "معرف_حركة_الاصناف_م","رقم_الحساب","معرف_الحساب","معرف_الصنف",
  "نوع_العمليه","ملاحظات_الخصم","رقم_السند","الانشاء_بدون_تعديل",
  "المنشى_بدون_تعديل","تكلفة_الوحده_المحسوبه","الكمية_المحسوبة_اخيرا",
  "رقم_الوصل","صندوق_الحساب_معرف",
];
const SALES_CASHBOX:Record<string,number>={
  "اسامة زيد":2417,"الواصلي":2408,"اية":2402,"تخليد":2363,
  "حمزة":2414,"روان":2420,"عبدالله عثمان":2405,"مامون":2360,
};
type SourceRow={record:Record<string,string>; date:string; dateTime:string;
  invoice:string;legacyItem:string;legacyAccount:string;creator:string;
  movement:string;quantity:string;unitPrice:string};
function decodeXml(s:string):string{
  return s.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,v:string)=>{
    const n=v[0]?.toLowerCase()==="x"?parseInt(v.slice(1),16):parseInt(v,10);
    return n>=0&&n<=0x10ffff?String.fromCodePoint(n):"";
  }).replace(/&(amp|lt|gt|quot|apos);/g,(_,v:string)=>
    ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'"} as Record<string,string>)[v]??"");
}
function zipMember(bytes:Buffer,filename:string):Buffer{
  const eocd=bytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
  if(eocd<0)throw new Error("Private Excel ZIP footer missing");
  const entries=bytes.readUInt16LE(eocd+10);
  let position=bytes.readUInt32LE(eocd+16);
  for(let i=0;i<entries;i++){
    if(bytes.readUInt32LE(position)!==0x02014b50)throw new Error("Invalid Excel ZIP directory");
    const method=bytes.readUInt16LE(position+10);
    const compressed=bytes.readUInt32LE(position+20);
    const originalSize=bytes.readUInt32LE(position+24);
    const nameSize=bytes.readUInt16LE(position+28);
    const extraSize=bytes.readUInt16LE(position+30);
    const commentSize=bytes.readUInt16LE(position+32);
    const local=bytes.readUInt32LE(position+42);
    const name=bytes.subarray(position+46,position+46+nameSize).toString("utf8");
    position+=46+nameSize+extraSize+commentSize;
    if(name!==filename)continue;
    if(originalSize>15_000_000)throw new Error("Private Excel sheet exceeds intake bound");
    if(bytes.readUInt32LE(local)!==0x04034b50)throw new Error("Invalid Excel ZIP item");
    const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    const payload=bytes.subarray(start,start+compressed);
    const extracted=method===0?Buffer.from(payload):
      method===8?inflateRawSync(payload,{maxOutputLength:15_000_000}):
      (()=>{throw new Error("Unsupported Excel ZIP compression");})();
    if(extracted.length!==originalSize)throw new Error("Invalid private Excel sheet length");
    return extracted;
  }
  throw new Error("Private Excel sheet is missing");
}
function sourceLocalTime(excelSerial:string):string{
  const n=Number(excelSerial);
  if(!Number.isFinite(n)||n<46000||n>47000)throw new Error("Invalid October source timestamp");
  return new Date(Date.UTC(1899,11,30)+Math.round(n*86400000))
    .toISOString().slice(0,19);
}
function sixDecimals(raw:string):string{
  const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if(!match)throw new Error("Invalid source quantity");
  const fraction=match[3]??"";
  let n=BigInt(match[2])*1_000_000n+
    BigInt((fraction+"000000").slice(0,6));
  if(fraction.length>6&&fraction[6]>="5")n+=1n;
  if(n===0n)throw new Error("Source quantity cannot round to zero");
  const digits=(n%1_000_000n).toString().padStart(6,"0").replace(/0+$/,"");
  return (match[1]==="-"?"-":"")+(n/1_000_000n).toString()+
    (digits?"."+digits:"");
}
function parseSheet(bytes:Buffer):SourceRow[]{
  const xml=zipMember(bytes,"xl/worksheets/sheet1.xml").toString("utf8");
  const rows:SourceRow[]=[];
  const found=new Set<string>();
  const rowPattern=/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellPattern=/<c\b[^>]*\br="([A-M])(\d+)"[^>]*>([\s\S]*?)<\/c>/g;
  for(const match of xml.matchAll(rowPattern)){
    const rowNumber=Number(match[1]);
    const cols=Array<string>(13).fill("");
    for(const c of match[2]!.matchAll(cellPattern)){
      const index=c[1]!.charCodeAt(0)-65;
      const value=c[3]!.match(/<(?:t|v)(?:\s[^>]*)?>([\s\S]*?)<\/(?:t|v)>/);
      if(value)cols[index]=decodeXml(value[1]!);
    }
    if(rowNumber===1){
      if(cols.some((v,j)=>v!==HEADERS[j]))throw new Error("Private Excel headers differ");
      continue;
    }
    const [movement,numberAccount,legacyAccount,item,kind,notes,invoice,
      serial,creator,price,quantity,receipt,cashAccount]=cols;
    if(kind!=="فاتورة مبيعات"||!/^\d{15}$/.test(invoice)||
       !/^\d+$/.test(item)||!/^\d+$/.test(movement)||!creator||!price||!quantity)
      throw new Error("Invalid source Excel row "+rowNumber);
    const dateTime=sourceLocalTime(serial);
    const date=dateTime.slice(0,10);
    if(invoice.slice(0,6)!==date.slice(2,4)+date.slice(5,7)+date.slice(8,10))
      throw new Error("Source invoice date mismatch "+invoice);
    if(found.has(movement))throw new Error("Duplicate source movement "+movement);
    found.add(movement);
    const record=Object.fromEntries(HEADERS.map((name,j)=>[name,cols[j]!])) as Record<string,string>;
    record.__source_excel_row=String(rowNumber);
    record.__source_timezone="Asia/Aden";
    record.__source_file="مب.xlsx";
    rows.push({record,date,dateTime,invoice,legacyItem:item,
      legacyAccount:legacyAccount.trim(),creator,movement,quantity,unitPrice:price});
  }
  if(rows.length!==ROWS)throw new Error("Unexpected source Excel line count "+rows.length);
  return rows;
}
function canonical(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==="object")
    return Object.fromEntries(Object.entries(value as Record<string,unknown>)
      .sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
function hash(value:unknown):string{
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function uuid(value:string):string{
  const b=createHash("sha256").update(value).digest();
  b[6]=(b[6]!&15)|0x80;b[8]=(b[8]!&63)|0x80;
  const s=b.subarray(0,16).toString("hex");
  return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join("-");
}
/** Strictly an initial-stage operation; no accounting/stock posting or worker resume. */
export async function stagePrivateOctoberSalesFileOnce(pool:Pool):Promise<void>{
  const signed=process.env[ENV_KEY];
  if(!signed)return;
  // This private signed URL is read only; never log or return it.
  const target=new URL(signed);
  if(target.protocol!=="https:"||!target.hostname.endsWith(".oaiusercontent.com"))
    throw new Error("Private October sales source host is not approved");
  const response=await fetch(signed,{redirect:"error",signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error("Private October Excel download failed HTTP "+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>2_500_000)throw new Error("Private October Excel exceeds limit");
  if(createHash("sha256").update(bytes).digest("hex")!==FILE_SHA256)
    throw new Error("Private October Excel SHA256 mismatch");
  const rows=parseSheet(bytes);
  const docs=new Map<string,SourceRow[]>();
  for(const row of rows){
    const group=docs.get(row.invoice)??[];
    group.push(row);docs.set(row.invoice,group);
  }
  if(docs.size!==INVOICES)throw new Error("Unexpected private October invoice count "+docs.size);
  const ids=[...docs.keys()];
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('private-sales-intake-20261029'),$1)",[COMPANY_ID]);
    const authorized=await client.query("SELECT 1 FROM users WHERE id=$1 AND owner AND NOT suspended AND NOT archived",[OWNER_ID]);
    if(authorized.rowCount!==1)throw new Error("Owner authorization missing");
    const already=await client.query<{source_id:string}>(
      "SELECT source_id FROM transaction_source_imports WHERE company_id=$1 AND source_kind='invoice' AND source_id=ANY($2::text[]) "+
      "UNION SELECT source_id FROM legacy_import_staging WHERE company_id=$1 AND source_kind='invoice' AND source_id=ANY($2::text[])",
      [COMPANY_ID,ids],
    );
    const existing=new Set(already.rows.map(x=>x.source_id));
    const missing=ids.filter(x=>!existing.has(x));
    if(missing.length>1200)throw new Error("New invoice count exceeds permitted bounded intake");
    if(!missing.length){
      await client.query("COMMIT");
      console.info("PRIVATE_OCTOBER_SALES_INITIAL_STAGE",{source:INVOICES,existing:existing.size,staged:0});
      return;
    }
    const required=missing.flatMap(id=>docs.get(id)!);
    const oldItems=[...new Set(required.map(x=>x.legacyItem))];
    const itemRows=await client.query<{id:number;legacy_id:string}>(
      "SELECT id,legacy_id FROM items WHERE company_id=$1 AND legacy_id=ANY($2::text[])",
      [COMPANY_ID,oldItems]);
    const items=new Map<string,number>();
    for(const x of itemRows.rows){
      if(items.has(x.legacy_id))throw new Error("Duplicate source item mapping "+x.legacy_id);
      items.set(x.legacy_id,x.id);
    }
    const oldAccounts=[...new Set(required.map(x=>x.legacyAccount)
      .filter(x=>x!==""&&x!=="null"&&x!=="NULL"))];
    const accountRows=oldAccounts.length?await client.query<{legacy_id:number;account_id:number}>(
      "SELECT legacy_id,account_id FROM legacy_account_imports WHERE company_id=$1 AND source=$2 AND legacy_id=ANY($3::integer[])",
      [COMPANY_ID,"ac333333.xlsx",oldAccounts.map(Number)]):{rows:[]};
    const accounts=new Map<string,number>();
    for(const x of accountRows.rows)accounts.set(String(x.legacy_id),x.account_id);
    // All staged documents are validated before any row is inserted.
    const stageRows:Array<{source_id:string;posting_date:string;
      source_document:unknown;request_hash:string}>=[];
    const errors:string[]=[];
    let rounded=0;
    for(const sourceId of missing){
      const lines=docs.get(sourceId)!;
      const first=lines[0]!;
      if(lines.some(x=>x.creator!==first.creator||x.legacyAccount!==first.legacyAccount)){
        errors.push(sourceId+": inconsistent creator/account");continue;
      }
      const account=first.legacyAccount&&first.legacyAccount!=="null"?
        accounts.get(first.legacyAccount):SALES_CASHBOX[first.creator];
      if(!account){errors.push(sourceId+": unmapped account");continue;}
      if(lines.some(x=>!items.has(x.legacyItem))){
        errors.push(sourceId+": unmapped item");continue;
      }
      let preparedLines:{itemId:number;unit:1;quantity:string;unitPrice:string;expiryDate:null;originalLineId:null}[];
      try{
        preparedLines=lines.map(x=>{
          const quantity=sixDecimals(x.quantity);
          if(quantity!==x.quantity)rounded++;
          return {itemId:items.get(x.legacyItem)!,unit:1,quantity,
            unitPrice:x.unitPrice,expiryDate:null,originalLineId:null};
        });
      }catch(error){errors.push(sourceId+": "+(error instanceof Error?error.message:String(error)));continue;}
      const payload={
        idempotencyKey:uuid("initial-oct2026:"+sourceId),kind:"sale" as const,
        documentDate:first.date,currencyId:7,branchId:2,locationId:2,
        counterpartyAccountId:account,supplierAccountId:null,
        doctorId:null,doctorName:"",saleCustomerNumber:"",saleCustomerName:"",
        supplierReceiptNumber:"",
        description:"حفظ أولي من ملف مب.xlsx — فاتورة مبيعات تاريخية "+sourceId+
          " — المنشئ "+first.creator,
        discount:"0",lines:preparedLines,
      };
      const document={
        type:"invoice" as const,sourceId,
        sourceDocumentNumber:sourceId,
        sourceCreatedAt:first.dateTime+"+03:00",
        sourceCreators:[first.creator],
        sourceMovementIds:lines.map(x=>x.movement),
        sourceRows:lines.map(x=>x.record),
        payload,
      };
      const check=stagingBatchSchema.safeParse({
        idempotencyKey:uuid("initial-oct2026-batch:"+sourceId),
        sourceSystem:SOURCE_SYSTEM,postingDate:first.date,documents:[document],
      });
      if(!check.success){
        errors.push(sourceId+": "+check.error.issues.map(x=>x.message).join("; ").slice(0,180));
        continue;
      }
      const validated=check.data.documents[0];
      stageRows.push({source_id:sourceId,posting_date:first.date,
        source_document:validated,request_hash:hash(validated)});
    }
    if(errors.length){
      // Fail closed rather than silently staging incomplete invoices from a full-file request.
      throw new Error("Initial sales source validation failed for "+
        errors.length+" invoices; first "+errors.slice(0,6).join(" | "));
    }
    let inserted=0;
    for(let i=0;i<stageRows.length;i+=75){
      const group=stageRows.slice(i,i+75);
      const result=await client.query(
        "INSERT INTO legacy_import_staging "+
        "(company_id,source_system,source_kind,source_id,posting_date,source_document,request_hash,created_by) "+
        "SELECT $1,$2,'invoice',r.source_id,r.posting_date::date,r.source_document,r.request_hash,$3 "+
        "FROM jsonb_to_recordset($4::jsonb) AS r "+
        "(source_id text,posting_date text,source_document jsonb,request_hash text) "+
        "WHERE NOT EXISTS (SELECT 1 FROM transaction_source_imports p "+
        "WHERE p.company_id=$1 AND p.source_kind='invoice' AND p.source_id=r.source_id) "+
        "ON CONFLICT DO NOTHING RETURNING source_id",
        [COMPANY_ID,SOURCE_SYSTEM,OWNER_ID,JSON.stringify(group)]);
      inserted+=result.rowCount??0;
    }
    await client.query("COMMIT");
    console.info("PRIVATE_OCTOBER_SALES_INITIAL_STAGE",{
      source:INVOICES,sourceLines:ROWS,existing:existing.size,
      candidateNew:missing.length,staged:inserted,roundedFractionLines:rounded,
      accountingPosted:0,stockPosted:0,
    });
  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }finally{client.release();}
}
