import assert from "node:assert/strict";
import test, {mock} from "node:test";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import pg from "pg";

mock.module("../apps/api/src/policies/access.ts",{exports:{
  currentActor:async(_db,user)=>user, companyAccess:async(_db,user)=>({general:user.manager}),
}});
mock.module("../apps/api/src/services/pages.ts",{exports:{
  directoryEntries:async(_db,user)=>[{key:"company.inquiries",canManage:!user.pageBlocked&&(user.owner||user.manager)}],
  assertDirectoryAccess:(page,action)=>{if(action!=="view"&&!page.canManage)throw Object.assign(new Error("page"),{status:403});},
}});
mock.module("../apps/api/src/services/inquiry-notifications.ts",{exports:{
  syncUnansweredInquiryNotifications:async(db,companyId,ids)=>{
    for(const id of ids)await db.query("INSERT INTO fixture_notices VALUES($1,$2)",[companyId,id]);
  },
}});
mock.module("../apps/api/src/services/audit.ts",{exports:{audit:async()=>{}}});
const {inquiryRoutes}=await import("../apps/api/src/routes-inquiries.ts");
const root="/companies/:companyId/inquiries";
const admin={id:1,owner:true}, employee={id:2,owner:false}, limited={id:3,owner:false,manager:true,pageBlocked:true};
const uuid=()=>randomUUID();
const base=(i,group=false)=>({requestText:`synthetic ${i}`,taskName:group?"استكمال أسماء التراكيب مع الشكل الصيدلاني":"fixture",
  answerType:"text",responseMode:"first",positionKeys:["sales"],idempotencyKey:uuid(),
  ...(group?{linkedTable:"ai_tasks",linkedRecordId:429}:{}),
});
test("waiting ACL, no early notice, one reply role, Aden quota and idempotent concurrent native releases",async()=>{
 const native=process.env.INQUIRY_TEST_POSTGRES_SOCKET;
 const db=native?new pg.Pool({host:native,port:55479,user:"agent",database:"postgres",max:5}):new PGlite();
 const sql=(s)=>native?db.query(s):db.exec(s);
 try{
  await sql(`
   CREATE TABLE companies(id integer primary key,name text);
   CREATE TABLE users(id integer primary key,name text,archived boolean default false,suspended boolean default false,owner boolean default false);
   CREATE TABLE employees(company_id integer,user_id integer,active boolean,position_keys text[]);
   CREATE TABLE page_registry(key text primary key);
   CREATE TABLE permission_definitions(key text primary key,page_key text,action text,name text,rule_role text,required_permissions text[]);
   CREATE TABLE fixture_notices(company_id int,user_id int);
   INSERT INTO companies VALUES (2,'Dar'),(3,'Other');
   INSERT INTO users(id,name,owner) VALUES (1,'admin',true),(2,'staff',false),(3,'limited manager',false),(4,'new sales',false);
   INSERT INTO employees VALUES (2,2,true,ARRAY['sales']),(2,4,false,ARRAY['sales']);
  `);
  for(const name of ["20261108_inquiries_workflow.sql","20261118_zz_inquiry_task_name.sql","20261124_zzz_hidden_inquiry_queue.sql"])
    await sql(await readFile(new URL("../apps/api/migrations/"+name,import.meta.url),"utf8"));
  const adapt={query:async(...args)=>{const r=await db.query(...args);return {...r,rowCount:r.rows.length||r.affectedRows||0};},release(){}};
  const router=inquiryRoutes(native?db:{...adapt,connect:async()=>adapt});
  const call=(method,path,body={},user=admin,companyId=2,inquiryId) => new Promise((resolve)=>{
    let status=200;
    const handler=router.stack.find(x=>x.route?.methods?.[method] && [x.route.path].flat().includes(path)).route.stack[0].handle;
    const response={status:n=>{status=n;return response;},setHeader(){},json:data=>resolve({status,data})};
    handler({params:{companyId:String(companyId),inquiryId:inquiryId&&String(inquiryId)},auth:{user},body,query:{}},
      response,error=>resolve({status:error.status??500,error}));
  });
  const r=(path,b={},user=admin,cid=2)=>call("post",path,b,user,cid);
  assert.equal((await r(root,{...base("cross"),hidden:true},admin,3)).status,404);
  assert.equal((await r(root,{...base("staff"),hidden:true},employee)).status,403);
  assert.equal((await call("get",root+"/hidden",{},limited)).status,403);
  const first={...base("queued first"),hidden:true};
  const enrolled=await r(root,first);
  assert.equal(enrolled.status,201,String(enrolled.error?.stack));
  assert.equal(enrolled.data.hidden,true);
  assert.equal((await r(root,first)).data.queueId,enrolled.data.queueId);
  assert.equal((await call("get",root,{},employee)).data.items.length,0);
  assert.equal((await call("get",root+"/hidden",{},employee)).status,403);
  assert.equal((await call("get",root+"/hidden")).data.total,1);
  assert.equal((await call("post",root+"/:inquiryId/answers",{answerValue:"x",idempotencyKey:uuid()},employee,2,enrolled.data.queueId)).status,404);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM fixture_notices")).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM inquiry_targets")).rows[0].n,0);
  const now=await r(root,base("publish now"));
  assert.equal(now.data.recipientCount,1);
  assert.equal((await call("get",root,{},employee)).data.items.length,1);
  for(let i=0;i<5;i++)assert.equal((await r(root,base(i,true))).data.recipientCount,1);
  assert.equal((await r(root,base("sixth",true))).status,409);
  const held=await r(root,{...base("matched pending",true),hidden:true});
  assert.equal(held.data.hidden,true);
  for(let i=0;i<6;i++)assert.equal((await r(root,{...base(`queued ${i}`),hidden:true})).data.hidden,true);
  await sql("UPDATE employees SET active=(user_id=4) WHERE company_id=2 AND user_id IN(2,4)");
  const key={idempotencyKey:uuid()}, other={idempotencyKey:uuid()};
  const results=native?await Promise.all([r(root+"/hidden/release",key),r(root+"/hidden/release",other)])
    :[await r(root+"/hidden/release",key),await r(root+"/hidden/release",other)];
  for(const result of results)assert.equal(result.status,200,result.error?.message);
  const released=results.flatMap(x=>x.data.released);
  assert.equal(released.length,5);
  assert.equal(new Set(released.map(x=>x.queueId)).size,5);
  assert.equal(results.some(x=>x.data.releasedToday===5),true);
  assert.equal(results.every(x=>x.data.day===new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Aden"}).format(new Date())),true);
  const replay=await r(root+"/hidden/release",key);
  assert.deepEqual(replay.data,results[0].data);
  assert.equal((await call("get",root+"/hidden")).data.total,3);
  const targets=(await db.query("SELECT t.user_id FROM inquiry_targets t JOIN inquiry_hidden_queue q ON q.released_inquiry_id=t.inquiry_id")).rows;
  assert.deepEqual(targets.map(x=>x.user_id),[4,4,4,4,4]);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM fixture_notices WHERE user_id=4")).rows[0].n,5);
  assert.equal((await db.query("SELECT released_inquiry_id FROM inquiry_hidden_queue WHERE id=$1",[held.data.queueId])).rows[0].released_inquiry_id,null);
  // Move released rows to yesterday only in synthetic data; the same real handler must give today's fresh quota.
  await sql("UPDATE inquiry_hidden_queue SET released_day=released_day-1,released_at=released_at-interval '1 day' WHERE released_day IS NOT NULL");
  await sql("UPDATE inquiry_requests SET status='done' WHERE linked_record_id=429 AND status='open'");
  const nextDay=await r(root+"/hidden/release",{idempotencyKey:uuid()});
  assert.equal(nextDay.status,200,String(nextDay.error?.stack));
  assert.equal(nextDay.data.releasedToday,3);
  assert.equal(nextDay.data.released.some(x=>x.queueId===held.data.queueId),true);
  assert.equal((await call("get",root+"/hidden")).data.total,0);
  const slots=(await db.query("SELECT released_slot FROM inquiry_hidden_queue WHERE released_day=(clock_timestamp() AT TIME ZONE 'Asia/Aden')::date ORDER BY released_slot")).rows;
  assert.deepEqual(slots.map(x=>x.released_slot),[1,2,3]);
 } finally {await (native?db.end():db.close());}
});
