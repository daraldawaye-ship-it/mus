import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { Account, Branch, Company, CompanyCurrency, Item, Location, Page, SessionResponse } from "../packages/contracts/src/index.ts";

// Production URLs and inherited credentials must never enter these checks.
const databaseUrl = DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "Bulk-import-local-fixture-2026";
type Run = {idempotencyKey:string;status:string;phase:string;initialPending:number;imported:number;
  existing:number;failedDocuments:number;rounded:number;lastPostingDate:string|null};

class Client {
  private cookie="";
  private csrf:string|null=null;
  constructor(private readonly baseUrl:string){}
  async request<T>(method:string,path:string,body?:unknown){
    const headers=new Headers({accept:"application/json"});
    if(this.cookie)headers.set("cookie",this.cookie);
    if(method!=="GET"){
      headers.set("content-type","application/json");headers.set("origin",origin);
      if(this.csrf)headers.set("x-csrf-token",this.csrf);
    }
    const response=await fetch(`${this.baseUrl}/api${path}`,{method,headers,
      body:body===undefined?undefined:JSON.stringify(body)});
    for(const value of response.headers.getSetCookie())this.cookie=value.split(";",1)[0]!;
    const result:unknown=await response.json();
    if(result&&typeof result==="object"&&"csrf" in result)this.csrf=(result as SessionResponse).csrf;
    return {status:response.status,body:result as T};
  }
  async ok<T>(method:string,path:string,body?:unknown,status=200){
    const result=await this.request<T>(method,path,body);
    assert.equal(result.status,status,`${method} ${path}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
}

async function fixture(t:TestContext){
  const schema=`raw_audit_${randomUUID().replaceAll("-","")}`;
  const runtime=await createApp({databaseUrl,schema,appOrigin:origin,production:false,serveStatic:false});
  const server:Server=runtime.app.listen(0,"127.0.0.1");
  await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
  const address=server.address();assert(address&&typeof address!=="string");
  const baseUrl=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await runtime.close();
    const cleanup=new Pool({connectionString:databaseUrl});
    try{await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await cleanup.end();}
  });
  const user=await provisionOwner(runtime.pool,{name:"Admin",displayName:"Admin",email:"owner@raw-audit.test",password});
  const owner=new Client(baseUrl);
  await owner.ok("POST","/auth/login",{email:user.email,password});
  async function company(name="Bulk import local"){
    return (await owner.ok<{company:Company}>("POST","/companies",{name,phone:"",address:""},201)).company;
  }
  return {pool:runtime.pool,owner,user,company,client:()=>new Client(baseUrl)};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;

async function setup(f:Fixture){
  const company=await f.company(),base=`/companies/${company.id}`;
  const currency=(await f.owner.ok<Page<CompanyCurrency>>("GET",base+"/currencies")).items.find(x=>x.code==="YER")!;
  const branch=(await f.owner.ok<Page<Branch>>("GET",base+"/branches")).items[0]!;
  const location=(await f.owner.ok<Page<Location>>("GET",base+"/locations")).items[0]!;
  const counterparty=(await f.owner.ok<{account:Account}>("POST",base+"/accounts",{
    code:"0000000001",name:"Bulk supplier",parentId:null,kind:"posting",category:"asset",
    normalSide:"debit",cashOrBank:false,accountChoice:"customer",
  },201)).account;
  const item=(await f.owner.ok<{item:Item}>("POST",base+"/items",{
    idempotencyKey:randomUUID(),name:"Bulk historical item",unit1Name:"باكت",unit2Name:"شريط",unit3Name:"حبة",
    factor2:1,factor3:1,purchaseFactor:1,salePrice1:"20",salePrice2:"20",salePrice3:"20",
    purchasePrice:"10",hasExpiry:false,currencyId:currency.id,
  },201)).item;
  const sourceSystem="bulk-disposable-source";
  function source(sourceId:string,date:string,quantity="2",unitPrice="10"){
    return {type:"invoice" as const,sourceId,sourceDocumentNumber:"OLD-"+sourceId,
      sourceCreatedAt:date+"T08:12:13.123+03:00",sourceCreators:["Original operator"],
      sourceMovementIds:["movement-"+sourceId],
      sourceRows:[{id:sourceId,quantity,unitPrice,sourceNull:"null"}],
      payload:{idempotencyKey:randomUUID(),kind:"purchase" as const,documentDate:date,currencyId:currency.id,
        branchId:branch.id,locationId:location.id,counterpartyAccountId:counterparty.id,
        description:"Original historical purchase",discount:"0",
        lines:[{itemId:item.id,unit:1 as const,quantity,unitPrice,expiryDate:null}]}};
  }
  async function stage(documents:ReturnType<typeof source>[]){
    return f.owner.ok("POST",base+"/transaction-import/stage",{idempotencyKey:randomUUID(),sourceSystem,
      postingDate:documents[0]!.payload.documentDate,preserveDocumentDates:true,documents});
  }
  const start={idempotencyKey:randomUUID(),sourceSystem,roundUnitPrices:false};
  const bulkPath=base+"/transaction-import/bulk";
  const status=async()=> (await f.owner.ok<{run:Run}>("GET",bulkPath+"/"+start.idempotencyKey)).run;
  return {company,base,currency,branch,location,counterparty,item,sourceSystem,source,stage,start,bulkPath,status};
}

type RawStatus = {
  run:{idempotencyKey:string;companyId:number;sourceSystem:string;status:string;phase:string};
  raw:{documents:number;lines:number;sourceRows:number;sourceMovementIds:number;pending:number;
    completed:number;failed:number;firstDate:string|null;lastDate:string|null;invalidDocuments:number};
  scope:string;
  originalFileCoverageVerified:boolean;
};

async function snapshot(pool:Pool){
  const tables=["legacy_import_staging","legacy_import_runs","transaction_source_imports",
    "invoices","invoice_lines","financial_documents","financial_document_lines","stock_balances",
    "stock_item_valuations","stock_movements","stock_operations","item_statistics","audit_events",
    "transaction_import_batches","legacy_import_dirty_items"];
  const result:Record<string,unknown>={};
  for(const table of tables){
    result[table]=(await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) AS rows FROM ${table} r`)).rows[0].rows;
  }
  return result;
}

test("raw audit reads all stored headers and lines in a read-only snapshot while posting stays paused",async t=>{
  const f=await fixture(t),s=await setup(f);
  const first=s.source("raw-01","2013-09-06","0.333333","571.81818"),
    second=s.source("raw-02","2026-10-21","2","10");
  Object.assign(first.sourceRows[0]!,{unitPrice:"571.8181818",empty:"",zero:"0",
    __source_null_fields:'["sourceNull"]'});
  second.payload.lines.push({...second.payload.lines[0]!,quantity:"3",unitPrice:"20"});
  second.sourceRows.push({id:"raw-02-line2",quantity:"3",unitPrice:"20",sourceNull:"null"});
  second.sourceMovementIds.push("movement-raw-02-line2");
  await s.stage([first,second]);
  await f.owner.ok("POST",s.bulkPath,s.start,202);
  await f.owner.ok("POST",s.bulkPath+"/"+s.start.idempotencyKey+"/actions",{action:"pause"});
  assert.equal((await s.status()).status,"paused");
  assert.equal((await f.owner.request("GET",s.base+"/items")).status,409);
  const before=await snapshot(f.pool);

  // Observe the database setting at the actual raw aggregate, not just SQL text.
  const observed:Array<{readOnly:string;isolation:string}>=[];
  const wrapped=new WeakSet<object>();
  f.pool.on("acquire",client=>{
    if(wrapped.has(client))return;wrapped.add(client);
    const original=client.query.bind(client);
    client.query=((...args:unknown[])=>{
      const sql=args[0];
      if(typeof sql==="string"&&sql.includes("jsonb_array_length")){
        return (async()=>{
          const state=await original("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation");
          observed.push({readOnly:state.rows[0].readonly,isolation:state.rows[0].isolation});
          return Reflect.apply(original,client,args);
        })();
      }
      return Reflect.apply(original,client,args);
    }) as typeof client.query;
  });
  const report=await f.owner.ok<RawStatus>("GET",s.bulkPath+"/"+s.start.idempotencyKey+"/raw-status");
  assert.equal(report.scope,"staged_invoices");
  assert.equal(report.originalFileCoverageVerified,false);
  const {idempotencyKey,companyId,sourceSystem,status,phase}=report.run;
  assert.deepEqual({idempotencyKey,companyId,sourceSystem,status,phase},{idempotencyKey:s.start.idempotencyKey,companyId:s.company.id,
    sourceSystem:s.sourceSystem,status:"paused",phase:"importing"});
  assert.deepEqual(report.raw,{documents:2,lines:3,sourceRows:3,sourceMovementIds:3,
    pending:2,completed:0,failed:0,firstDate:"2013-09-06",lastDate:"2026-10-21",invalidDocuments:0});
  assert(observed.length>0,"actual aggregate must expose its read-only transaction setting");
  for(const setting of observed)assert.deepEqual(setting,{readOnly:"on",isolation:"repeatable read"});
  assert.deepEqual(await snapshot(f.pool),before,"raw inspection must not change intake, jobs, journals, stock, statistics, receipts, or audit");
  assert.equal((await s.status()).status,"paused");
  assert.deepEqual((await f.pool.query("SELECT source_document->'sourceRows' AS rows FROM legacy_import_staging WHERE company_id=$1 AND source_id='raw-01'",[s.company.id])).rows[0].rows,first.sourceRows);
  for(const table of ["invoices","financial_documents","stock_balances","stock_movements"])
    assert.equal((await f.pool.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n,0,table);
});

test("raw audit is owner-only and scopes both company and source to the addressed run",async t=>{
  const f=await fixture(t),s=await setup(f),other=await f.company("Unrelated raw source"),member=f.client();
  await member.ok("POST","/auth/register",{name:"Public member",displayName:"Public member",email:"member@raw-audit.test",phone:"",password},201);
  await s.stage([s.source("owned-raw","2026-01-03")]);
  await f.owner.ok("POST",s.bulkPath,s.start,202);
  await f.owner.ok("POST",s.bulkPath+"/"+s.start.idempotencyKey+"/actions",{action:"pause"});
  const path=s.bulkPath+"/"+s.start.idempotencyKey+"/raw-status";
  assert.equal((await member.request("GET",path)).status,403);
  assert.equal((await f.owner.request("GET",`/companies/${other.id}/transaction-import/bulk/${s.start.idempotencyKey}/raw-status`)).status,404);
  const wrongKey=await f.owner.request<{error:{code:string}}>("GET",s.bulkPath+"/"+randomUUID()+"/raw-status");
  assert.equal(wrongKey.status,409);assert.equal(wrongKey.body.error.code,"import_in_progress");
  // A different source's record cannot enter this run's totals, even in the same company.
  await f.pool.query(`INSERT INTO legacy_import_staging(company_id,source_system,source_kind,source_id,posting_date,source_document,request_hash,created_by)
    SELECT company_id,'unrelated-source',source_kind,'unrelated-id',posting_date,
      jsonb_set(source_document,'{sourceId}','"unrelated-id"'::jsonb),request_hash,created_by
    FROM legacy_import_staging WHERE company_id=$1 AND source_id='owned-raw'`,[s.company.id]);
  const report=await f.owner.ok<RawStatus>("GET",path);
  assert.equal(report.raw.documents,1);assert.equal(report.raw.lines,1);
  assert.equal(report.run.sourceSystem,s.sourceSystem);
  assert.equal(report.run.status,"paused");
});

