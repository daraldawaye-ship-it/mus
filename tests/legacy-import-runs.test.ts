import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { runLegacyImportStep } from "../apps/api/src/services/legacy-import-worker.ts";
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

async function fixture(t:TestContext, keepDatabasePaused=false){
  const schema=`bulk_import_${randomUUID().replaceAll("-","")}`;
  const runtime=await createApp({databaseUrl,schema,appOrigin:origin,production:false,serveStatic:false});
  if (!keepDatabasePaused) await runtime.pool.query("SELECT restore_database_automation()");
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
  const user=await provisionOwner(runtime.pool,{name:"Admin",displayName:"Admin",email:"owner@bulk.test",password});
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
  const start={idempotencyKey:randomUUID(),sourceSystem,roundUnitPrices:true};
  const bulkPath=base+"/transaction-import/bulk";
  const status=async()=> (await f.owner.ok<{run:Run}>("GET",bulkPath+"/"+start.idempotencyKey)).run;
  return {company,base,currency,branch,location,counterparty,item,sourceSystem,source,stage,start,bulkPath,status};
}

test("bulk import keeps source precision, resumes per day, and rebuilds projections only at completion",async t=>{
  const f=await fixture(t),s=await setup(f),other=await f.company("Unaffected company");
  const first=s.source("source-01","2026-10-01","2","571.81818"),
    second=s.source("source-02","2026-10-02","3","10"),
    fractional=s.source("source-03","2026-10-02","0.5","10");
  await s.stage([first,second,fractional]);
  const started=await f.owner.ok<{run:Run;replayed:boolean}>("POST",s.bulkPath,s.start,202);
  assert.equal(started.run.initialPending,3);assert.equal(started.replayed,false);
  assert.equal((await f.owner.ok<{replayed:boolean}>("POST",s.bulkPath,s.start,202)).replayed,true);
  assert.equal((await f.owner.request("POST",s.bulkPath,{...s.start,roundUnitPrices:false})).status,409);
  assert.equal((await f.owner.request<{error:{code:string}}>("GET",s.base+"/items")).body.error.code,"import_in_progress");
  await f.owner.ok("GET",`/companies/${other.id}/currencies`);
  assert.equal((await f.owner.request("GET",`/companies/${other.id}/transaction-import/bulk/${s.start.idempotencyKey}`)).status,404);

  // Status must remain readable while a long posting transaction owns the company lock.
  const locked=await f.pool.connect();
  try{
    await locked.query("BEGIN");await locked.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE",[s.company.id]);
    const status=await Promise.race([s.status(),new Promise<never>((_,reject)=>{
      const timer=setTimeout(()=>reject(new Error("Bulk status waited on company write lock")),2000);timer.unref();
    })]);
    assert.equal(status.status,"running");
  }finally{await locked.query("ROLLBACK");locked.release();}

  await runLegacyImportStep(f.pool);
  let run=await s.status();assert.equal(run.imported,1);assert.equal(run.rounded,1);
  assert.equal((await f.pool.query("SELECT stock_total::text FROM item_statistics WHERE company_id=$1 AND item_id=$2",[s.company.id,s.item.id])).rows[0].stock_total,"0");
  assert.equal((await f.pool.query("SELECT sum(quantity_smallest)::text AS quantity FROM stock_balances WHERE company_id=$1 AND item_id=$2",[s.company.id,s.item.id])).rows[0].quantity,"2");
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM legacy_import_dirty_items WHERE company_id=$1",[s.company.id])).rows[0].n,1);
  const firstPosted=(await f.pool.query(`SELECT s.source_metadata,l.unit_price::text AS price,i.document_date::text AS date
    FROM transaction_source_imports s JOIN invoices i ON i.company_id=s.company_id AND i.id=s.invoice_id
    JOIN invoice_lines l ON l.company_id=i.company_id AND l.invoice_id=i.id
    WHERE s.company_id=$1 AND s.source_system=$2 AND s.source_id=$3`,[s.company.id,s.sourceSystem,first.sourceId])).rows[0];
  assert.deepEqual(firstPosted.source_metadata.sourceRows,first.sourceRows);
  assert.equal(firstPosted.price,"571.820000");assert.equal(firstPosted.date,"2026-10-01");
  assert.deepEqual((await f.pool.query("SELECT source_document->'sourceRows' AS rows FROM legacy_import_staging WHERE company_id=$1 AND source_id=$2",[s.company.id,first.sourceId])).rows[0].rows,first.sourceRows);

  await f.owner.ok("POST",s.bulkPath+"/"+s.start.idempotencyKey+"/actions",{action:"pause"});
  await runLegacyImportStep(f.pool);assert.equal((await s.status()).imported,1);
  await f.owner.ok("POST",s.bulkPath+"/"+s.start.idempotencyKey+"/actions",{action:"resume"});
  await runLegacyImportStep(f.pool);
  run=await s.status();assert.equal(run.imported,2);assert.equal(run.failedDocuments,1);
  const intake=(await f.pool.query("SELECT source_id,status,source_document->'payload'->'lines'->0->>'quantity' AS quantity FROM legacy_import_staging WHERE company_id=$1 ORDER BY source_id",[s.company.id])).rows;
  assert.deepEqual(intake.map(x=>[x.source_id,x.status]),[["source-01","completed"],["source-02","completed"],["source-03","failed"]]);
  assert.equal(intake[2].quantity,"0.5");
  assert.equal((await f.pool.query("SELECT stock_total::text FROM item_statistics WHERE company_id=$1 AND item_id=$2",[s.company.id,s.item.id])).rows[0].stock_total,"0");
  for(let attempt=0;attempt<4&&(await s.status()).status!=="completed";attempt++)await runLegacyImportStep(f.pool);
  run=await s.status();assert.equal(run.status,"completed");assert.equal(run.imported,2);assert.equal(run.failedDocuments,1);
  const derived=(await f.pool.query(`SELECT s.stock_total::text AS projected,
    (SELECT sum(quantity_smallest)::text FROM stock_balances WHERE company_id=s.company_id AND item_id=s.item_id) AS actual,
    (SELECT sum(purchase_quantity)::text FROM item_daily_activity WHERE company_id=s.company_id AND item_id=s.item_id) AS purchases
    FROM item_statistics s WHERE s.company_id=$1 AND s.item_id=$2`,[s.company.id,s.item.id])).rows[0];
  assert.equal(derived.projected,"5");assert.equal(derived.actual,"5");assert.equal(derived.purchases,"5");
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM legacy_import_dirty_items WHERE company_id=$1",[s.company.id])).rows[0].n,0);
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM financial_documents WHERE company_id=$1 AND (total_debit<>total_credit OR total_base_debit<>total_base_credit)",[s.company.id])).rows[0].n,0);
  await f.owner.ok("GET",s.base+"/items");
  await runLegacyImportStep(f.pool);
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM transaction_source_imports WHERE company_id=$1",[s.company.id])).rows[0].n,2);
});

test("bulk transaction rollback preserves pending intake and resume never duplicates a committed invoice",async t=>{
  const f=await fixture(t),s=await setup(f);
  await s.stage([s.source("rollback-source","2026-10-03")]);
  await f.owner.ok("POST",s.bulkPath,s.start,202);
  await f.pool.query(`CREATE FUNCTION reject_bulk_import_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='company.transactions.import' THEN RAISE EXCEPTION 'test audit rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_bulk_import_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_bulk_import_audit()`);
  await runLegacyImportStep(f.pool);
  assert.equal((await s.status()).status,"failed");
  const rolledBack=(await f.pool.query(`SELECT
    (SELECT count(*)::integer FROM invoices WHERE company_id=$1) AS invoices,
    (SELECT count(*)::integer FROM transaction_source_imports WHERE company_id=$1) AS sources,
    (SELECT count(*)::integer FROM transaction_import_batches WHERE company_id=$1) AS receipts,
    (SELECT count(*)::integer FROM legacy_import_staging WHERE company_id=$1 AND status='pending') AS pending`,[s.company.id])).rows[0];
  assert.deepEqual(rolledBack,{invoices:0,sources:0,receipts:0,pending:1});
  await f.pool.query("DROP TRIGGER reject_bulk_import_audit ON audit_events; DROP FUNCTION reject_bulk_import_audit()");
  await f.owner.ok("POST",s.bulkPath+"/"+s.start.idempotencyKey+"/actions",{action:"resume"});
  for(let attempt=0;attempt<5&&(await s.status()).status!=="completed";attempt++)await runLegacyImportStep(f.pool);
  assert.equal((await s.status()).status,"completed");
  assert.equal((await s.status()).imported,1);
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM invoices WHERE company_id=$1",[s.company.id])).rows[0].n,1);
  await runLegacyImportStep(f.pool);
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM invoices WHERE company_id=$1",[s.company.id])).rows[0].n,1);
});

test("only the current owner controls bulk jobs and explicit partial finish restores normal access",async t=>{
  const f=await fixture(t),s=await setup(f),member=f.client();
  await member.ok("POST","/auth/register",{name:"Public member",displayName:"Public member",email:"member@bulk.test",phone:"",password},201);
  await s.stage([s.source("partial-01","2026-10-04"),s.source("partial-02","2026-10-05")]);
  assert.equal((await member.request("POST",s.bulkPath,s.start)).status,403);
  await f.owner.ok("POST",s.bulkPath,s.start,202);
  assert.equal((await member.request("GET",s.bulkPath+"/"+s.start.idempotencyKey)).status,403);
  assert.equal((await member.request("POST",s.bulkPath+"/"+s.start.idempotencyKey+"/actions",{action:"finish"})).status,403);
  await runLegacyImportStep(f.pool);
  await f.owner.ok("POST",s.bulkPath+"/"+s.start.idempotencyKey+"/actions",{action:"finish"});
  await runLegacyImportStep(f.pool);
  assert.equal((await s.status()).status,"completed");assert.equal((await s.status()).imported,1);
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM legacy_import_staging WHERE company_id=$1 AND status='pending'",[s.company.id])).rows[0].n,1);
  await f.owner.ok("GET",s.base+"/items");
  const next={...s.start,idempotencyKey:randomUUID()};
  await f.owner.ok("POST",s.bulkPath,next,202);
  for(let attempt=0;attempt<5;attempt++){
    await runLegacyImportStep(f.pool);
    const run=(await f.owner.ok<{run:Run}>("GET",s.bulkPath+"/"+next.idempotencyKey)).run;
    if(run.status==="completed")break;
  }
  assert.equal((await f.pool.query("SELECT count(*)::integer AS n FROM transaction_source_imports WHERE company_id=$1",[s.company.id])).rows[0].n,2);
});


test("authorized posting during database pause stops before rebuilding and preserves source identities",async t=>{
  const f=await fixture(t,true),s=await setup(f);
  await s.stage([s.source("paused-01","2026-10-01"),s.source("paused-02","2026-10-02")]);
  await f.owner.ok("POST",s.bulkPath,s.start,202);
  await runLegacyImportStep(f.pool);
  await runLegacyImportStep(f.pool);
  await runLegacyImportStep(f.pool);
  const run=await s.status();
  assert.equal(run.imported,2);assert.equal(run.status,"paused");
  const snapshot=await f.pool.query(`SELECT
    (SELECT phase FROM legacy_import_runs WHERE company_id=$1) AS phase,
    (SELECT paused FROM automation_database_pause WHERE singleton) AS paused,
    (SELECT count(*)::integer FROM transaction_source_imports WHERE company_id=$1) AS sources,
    (SELECT count(*)::integer FROM financial_documents WHERE company_id=$1 AND total_debit<>total_credit) AS unbalanced,
    (SELECT count(*)::integer FROM legacy_import_dirty_items WHERE company_id=$1) AS dirty,
    (SELECT count(*)::integer FROM item_daily_activity WHERE company_id=$1) AS daily`,[s.company.id]);
  assert.deepEqual(snapshot.rows[0],{phase:"awaiting_reconciliation",paused:true,sources:2,unbalanced:0,dirty:1,daily:0});
  await runLegacyImportStep(f.pool);
  assert.equal((await s.status()).imported,2);
});
