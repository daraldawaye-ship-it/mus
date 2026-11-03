import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";

const dbUrl=process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin="http://localhost";
const password="Purchase-factor-import-isolated-test";
class Client {
  private cookie="";
  private csrf="";
  constructor(private base:string){}
  async call(method:string,path:string,body?:unknown) {
    const headers=new Headers({accept:"application/json"});
    if(this.cookie)headers.set("cookie",this.cookie);
    if(method!=="GET"){
      headers.set("origin",origin);
      headers.set("content-type","application/json");
      if(this.csrf)headers.set("x-csrf-token",this.csrf);
    }
    const response=await fetch(this.base+"/api"+path,{method,headers,
      body:body===undefined?undefined:JSON.stringify(body)});
    for(const value of response.headers.getSetCookie())this.cookie=value.split(";",1)[0]!;
    const value=await response.json() as Record<string,any>;
    if(value.csrf)this.csrf=value.csrf;
    return {status:response.status,body:value};
  }
  async ok(method:string,path:string,body?:unknown,status=200){
    const result=await this.call(method,path,body);
    assert.equal(result.status,status,method+" "+path+": "+JSON.stringify(result.body));
    return result.body;
  }
}
async function setup(t:TestContext){
  const schema="factor_"+randomUUID().replaceAll("-","");
  const runtime=await createApp({databaseUrl:dbUrl,schema,appOrigin:origin,
    production:false,serveStatic:false});
  const server=runtime.app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const addr=server.address();
  assert(addr&&typeof addr==="object");
  t.after(async()=>{
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await runtime.close();
    const pool=new Pool({connectionString:dbUrl});
    try{await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}
    finally{await pool.end();}
  });
  const user=await provisionOwner(runtime.pool,{name:"Test owner",displayName:"Test owner",
    email:"owner@purchase-factors.test",password});
  const client=new Client("http://127.0.0.1:"+addr.port);
  await client.ok("POST","/auth/login",{email:user.email,password});
  await client.ok("POST","/companies",{name:"شركة أخرى",phone:"",address:""},201);
  const company=(await client.ok("POST","/companies",
    {name:"صيدلية دار الدواء",phone:"",address:""},201)).company;
  assert.equal(company.id,2);
  const currency=await runtime.pool.query<{id:number}>(
    "SELECT id FROM company_currencies WHERE company_id=$1 AND active=true ORDER BY id LIMIT 1",
    [company.id]);
  let currencyId=currency.rows[0]?.id;
  if(!currencyId){
    const created=await client.ok("POST",'/companies/'+company.id+'/currencies',
      {code:"YER",name:"ريال يمني",decimalPlaces:0},201);
    currencyId=created.currency.id;
  }
  const item=async (legacyId:string,name:string)=>{
    const created=await client.ok("POST",'/companies/'+company.id+'/items',
      {name,legacyId,currencyId,idempotencyKey:randomUUID()},201);
    return created.item as {id:number;revision:number;legacyId:string;purchaseFactor:number};
  };
  return {client,pool:runtime.pool,item};
}

test("Table13 import: preflight, guarded batch, actual purchase-factor update, audit and retry",async t=>{
  const f=await setup(t);
  const first=await f.item("8252","إبرة 5 سي سي");
  const second=await f.item("8365","محلول تسريب");
  const body={source:"Table13.xlsx",items:[
    {legacyId:"8252",purchaseFactor:100},
    {legacyId:"8365",purchaseFactor:36},
    {legacyId:"999999999",purchaseFactor:2},
  ]};
  const path="/companies/2/items/purchase-factor-import";
  const dry=await f.client.ok("POST",path,{...body,dryRun:true});
  assert.deepEqual(
    {received:dry.result.received,matched:dry.result.matched,wouldChange:dry.result.wouldChange,updated:dry.result.updated},
    {received:3,matched:2,wouldChange:2,updated:0});
  assert.deepEqual(dry.result.missingLegacyIds,["999999999"]);
  assert.equal((await f.pool.query("SELECT purchase_factor FROM items WHERE id=$1",[first.id])).rows[0].purchase_factor,1);
  assert.equal((await f.client.call("POST","/companies/1/items/purchase-factor-import",
    {...body,dryRun:false})).status,403);
  assert.equal((await f.client.call("POST",path,{...body,items:[{legacyId:"8252",purchaseFactor:0}]})).status,400);
  assert.equal((await f.client.call("POST",path,{...body,items:[{legacyId:"8252",purchaseFactor:1.5}]})).status,400);
  assert.equal((await f.client.call("POST",path,{...body,items:[
    {legacyId:"8252",purchaseFactor:10},{legacyId:"8252",purchaseFactor:20},
  ]})).status,400);
  const saved=await f.client.ok("POST",path,{...body,dryRun:false});
  assert.equal(saved.result.updated,2);
  assert.equal(saved.result.matched,2);
  assert.equal(saved.result.alreadyCorrect,0);
  const rows=await f.pool.query(
    "SELECT id,purchase_factor,revision FROM items WHERE id=ANY($1::int[]) ORDER BY id",
    [[first.id,second.id]]);
  const data=new Map(rows.rows.map(row=>[row.id,row]));
  assert.equal(data.get(first.id)?.purchase_factor,100);
  assert.equal(data.get(second.id)?.purchase_factor,36);
  assert.equal(data.get(first.id)?.revision,first.revision+1);
  assert.equal(data.get(second.id)?.revision,second.revision+1);
  const audits=await f.pool.query(
    "SELECT target_id,before_value,after_value FROM audit_events WHERE company_id=2 AND target_type='item' AND action='item.field.update' AND target_id=ANY($1::int[])",
    [[first.id,second.id]]);
  assert.equal(audits.rowCount,2);
  assert.ok(audits.rows.every(row=>row.before_value.field==="purchaseFactor" && row.before_value.value===1));
  assert.deepEqual(new Set(audits.rows.map(row=>row.after_value.value)),new Set([100,36]));
  const retry=await f.client.ok("POST",path,{...body,dryRun:false});
  assert.equal(retry.result.updated,0);
  assert.equal(retry.result.alreadyCorrect,2);
  assert.equal((await f.pool.query(
    "SELECT count(*)::integer AS total FROM audit_events WHERE company_id=2 AND action='item.field.update' AND target_id=ANY($1::int[])",
    [[first.id,second.id]])).rows[0].total,2);
});

test("Table13 connector contract is discoverable and does not expose bulk arbitrary SQL",()=>{
  const mcp=JSON.parse(readFileSync("apps/api/src/mcp-contracts.json","utf8"));
  const contract=mcp["POST /companies/:companyId/items/purchase-factor-import"];
  assert.equal(contract.bodySchema.properties.source.const,"Table13.xlsx");
  assert.equal(contract.bodySchema.properties.items.maxItems,100);
  assert.equal(contract.bodySchema.properties.items.items.properties.purchaseFactor.minimum,1);
  const src=readFileSync("apps/api/src/routes-item-import.ts","utf8");
  assert.match(src,/mutateMaster\(pool,req,"items.manage"/);
  assert.match(src,/companyId!==2/);
  assert.match(src,/SELECT id,legacy_id,purchase_factor FROM items/);
  assert.match(src,/purchase_factor=updates.factor/);
  assert.match(src,/revision=i.revision\+1/);
  assert.match(src,/item.field.update/);
  assert.doesNotMatch(src,/UPDATE stock_balances|UPDATE invoice_lines/);
});
