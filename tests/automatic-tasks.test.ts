import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";

test("automatic task controls stay code-owned, scoped, audited, and revision guarded", async t=>{
 const schema="tasks_test_"+randomUUID().replaceAll("-","");
 const runtime=await createApp({databaseUrl:process.env.DATABASE_URL??DEFAULT_DATABASE_URL,
  schema,appOrigin:"http://localhost",serveStatic:false,production:false});
 const server=runtime.app.listen(0,"127.0.0.1");
 await new Promise<void>(resolve=>server.once("listening",resolve));
 const address=server.address();
 assert(address&&typeof address!=="string");
 const origin=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await runtime.close();
  const pool=new Pool({connectionString:process.env.DATABASE_URL??DEFAULT_DATABASE_URL});
  try{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)}finally{await pool.end()}
 });
 const password="tasks-testing-very-long-secret";
 const user=await provisionOwner(runtime.pool,{name:"Owner",displayName:"Owner",email:"owner@tasks.test",password});
 let cookie="",csrf="";
 const request=async(method:string,path:string,body?:unknown)=>{
  const response=await fetch(origin+"/api"+path,{
   method,headers:{cookie,...(method!=="GET"?{"content-type":"application/json",origin:"http://localhost","x-csrf-token":csrf}:{})},
   body:body===undefined?undefined:JSON.stringify(body),
  });
  for(const value of response.headers.getSetCookie())cookie=value.split(";")[0]!;
  const json=await response.json() as any;
  if(json?.csrf)csrf=json.csrf;
  return {status:response.status,json};
 };
 assert.equal((await request("POST","/auth/login",{email:user.email,password})).status,200);
 const company=await request("POST","/companies",{name:"Task Company",phone:"",address:""});
 assert.equal(company.status,201,JSON.stringify(company.json));
 const companyId=company.json.company.id;
 const list=await request("GET",`/companies/${companyId}/tasks?all=true`);
 assert.equal(list.status,200,JSON.stringify(list.json));
 assert.deepEqual(list.json.items.map((x:any)=>x.key),["memo_required","composition_review","stock_count"]);
 assert.equal(list.json.items.find((x:any)=>x.key==="composition_review").targetCount,3);
 const body={revision:0,enabled:true,targetCount:5,periodDays:7,
  assignedEmployeeIds:[],followerEmployeeIds:[]};
 const saved=await request("PUT",`/companies/${companyId}/tasks/composition_review`,body);
 assert.equal(saved.status,200,JSON.stringify(saved.json));
 assert.equal(saved.json.settings.revision,1);
 assert.equal(saved.json.settings.targetCount,5);
 const stale=await request("PUT",`/companies/${companyId}/tasks/composition_review`,body);
 assert.equal(stale.status,409);
 const invalid=await request("PUT",`/companies/${companyId}/tasks/stock_count`,
  {...body,assignedEmployeeIds:[999999]});
 assert.equal(invalid.status,400);
 const fresh=await request("GET",`/companies/${companyId}/tasks?all=true`);
 assert.equal(fresh.status,200);
 assert.equal(fresh.json.items.find((x:any)=>x.key==="composition_review").periodDays,7);
 const publicTasks=await request("GET","/tasks");
 assert.equal(publicTasks.status,200);
 assert.deepEqual(publicTasks.json.items,[]);
 const audit=await runtime.pool.query(
  "SELECT action,company_id FROM audit_events WHERE company_id=$1 AND action='automaticTask.settings'",[companyId]);
 assert.equal(audit.rowCount,1);
});
