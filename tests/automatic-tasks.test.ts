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
 // Every result is owned by the ACTUAL user; one employee's activity never
 // fulfills another employee's task within the same company.
 const worker=async(index:number)=>{
  let workerCookie="",workerCsrf="";
  const call=async(method:string,path:string,body?:unknown)=>{
   const response=await fetch(origin+"/api"+path,{
    method,headers:{cookie:workerCookie,...(method!=="GET"?{
     "content-type":"application/json",origin:"http://localhost","x-csrf-token":workerCsrf
    }:{})},
    body:body===undefined?undefined:JSON.stringify(body)
   });
   for(const value of response.headers.getSetCookie())workerCookie=value.split(";")[0]!;
   const json=await response.json() as any;
   if(json?.csrf)workerCsrf=json.csrf;
   return {status:response.status,json};
  };
  const joined=await call("POST","/auth/register",{
   name:"Worker "+index,displayName:"Worker "+index,
   email:`worker-${index}@tasks.test`,phone:"",password
  });
  assert.equal(joined.status,201,JSON.stringify(joined.json));
  const employee=await request("POST",`/companies/${companyId}/employees`,{
   userId:joined.json.user.id,name:"Worker "+index,phone:"",role:"employee",
   active:true,permissions:["items.view","items.manage","inventory.view","inventory.post","finance.post"]
  });
  assert.equal(employee.status,201,JSON.stringify(employee.json));
  return {id:joined.json.user.id,call};
 };
 const alice=await worker(1),bob=await worker(2);
 await runtime.pool.query(`INSERT INTO item_compositions
  (company_id,arabic_name,english_name,created_by,idempotency_key,creation_payload)
  VALUES ($1,'اختبار المهام','Task count test',$2,$3,'{}'::jsonb)`,
  [companyId,user.id,randomUUID()]);
 for(let n=0;n<3;n++)await runtime.pool.query(`
  INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type)
  VALUES($1,'Worker 1','company',$2,'itemComposition.update','itemComposition')`,
  [alice.id,companyId]);
 const a=await alice.call("GET",`/companies/${companyId}/tasks?all=true`);
 const b=await bob.call("GET",`/companies/${companyId}/tasks?all=true`);
 assert.equal(a.status,200,JSON.stringify(a.json));
 assert.equal(b.status,200,JSON.stringify(b.json));
 const composition=(result:any)=>result.json.items.find((x:any)=>x.key==="composition_review");
 assert.equal(composition(a).completed,3);
 assert.equal(composition(a).required,2);
 assert.equal(composition(b).completed,0);
 assert.equal(composition(b).required,5);

 // Seed synthetic immutable count events solely to prove per-user aggregation.
 // Real counts are accepted only through the validated due-stock task workflow.
 const currency=(await runtime.pool.query("SELECT id FROM company_currencies WHERE company_id=$1 LIMIT 1",[companyId])).rows[0].id;
 const stockItem=(await runtime.pool.query(`INSERT INTO items
  (company_id,code,name,unit1_name,currency_id,created_by,idempotency_key,creation_payload,created_at)
  VALUES($1,'00000001','Count task test item','piece',$2,$3,$4,'{}'::jsonb,clock_timestamp()-interval '90 days')
  RETURNING id`,[companyId,currency,user.id,randomUUID()])).rows[0].id;
 for(let n=0;n<10;n++){
  const operation=(await runtime.pool.query(`INSERT INTO stock_operations
   (company_id,kind,document_date,description,created_by,idempotency_key,creation_payload)
   VALUES($1,'adjustment',current_date,'test actor isolation',$2,$3,'{}'::jsonb) RETURNING id`,
   [companyId,alice.id,randomUUID()])).rows[0].id;
  await runtime.pool.query(`INSERT INTO automatic_task_count_events
   (company_id,operation_id,item_id,actor_user_id) VALUES($1,$2,$3,$4)`,
   [companyId,operation,stockItem,alice.id]);
 }
 // Stock statistics are read projections; synthetic showroom availability for test.
 await runtime.pool.query(`UPDATE item_statistics SET
  stock_total=5,stock_showroom=5,stock_warehouse=0
  WHERE company_id=$1 AND item_id=$2`,[companyId,stockItem]);
 const countedA=await alice.call("GET",`/companies/${companyId}/tasks?all=true`);
 const countedB=await bob.call("GET",`/companies/${companyId}/tasks?all=true`);
 assert.equal(countedA.status,200,JSON.stringify(countedA.json));
 assert.equal(countedB.status,200,JSON.stringify(countedB.json));
 const stock=(result:any)=>result.json.items.find((x:any)=>x.key==="stock_count");
 assert.equal(stock(countedA).completed,10);
 assert.equal(stock(countedA).required,0);
 assert.equal(stock(countedB).completed,0);
 assert.equal(stock(countedB).required,10);

});
