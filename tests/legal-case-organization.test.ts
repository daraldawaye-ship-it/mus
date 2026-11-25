import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import express from "express";
import { ZodError } from "zod";
import { PGlite } from "@electric-sql/pglite";
import type { Pool, QueryResultRow } from "pg";
import { legalCaseRoutes } from "../apps/api/src/routes-legal-cases.ts";
import { userDTO } from "../apps/api/src/repositories/models.ts";
import { HttpError } from "../apps/api/src/errors.ts";

test("organization preserves source data and case relationships enforce both permissions and revisions",async t=>{
  const db=new PGlite();
  await db.exec(`CREATE TABLE users(id integer PRIMARY KEY,name text,display_name text,owner boolean,
      archived boolean DEFAULT false,created_at timestamptz DEFAULT now());
    INSERT INTO users VALUES(1,'Owner','Owner',true,false,now()),(2,'Editor','Editor',false,false,now());
    CREATE TABLE general_table(general_table_id integer PRIMARY KEY);
    CREATE TABLE page_settings(page_key text,company_id integer,enabled boolean);
    CREATE TABLE legal_case_access(case_id integer,user_id integer,role text);
    CREATE TABLE legal_records(id integer PRIMARY KEY,created_by integer NOT NULL DEFAULT 1,kind text NOT NULL DEFAULT 'document',sort_order integer DEFAULT 0,record_date date);
    CREATE TABLE legal_record_links(first_record_id integer,second_record_id integer);
    CREATE TABLE legal_record_cases(record_id integer,case_id integer);
    CREATE TABLE audit_events(actor_id integer,actor_name text,scope text,company_id integer,
      action text,target_type text,target_id integer,before_value jsonb,after_value jsonb);`);
  const original=await readFile("apps/api/migrations/118_legal_case_management.sql","utf8");
  await db.exec(original.slice(0,original.indexOf("CREATE INDEX")));
  await db.exec(await readFile("apps/api/migrations/20261116_legal_case_list_fields.sql","utf8"));
  const migration=await readFile("apps/api/migrations/20261125_legal_case_organization.sql","utf8");
  await db.exec(migration);
  await db.exec(migration);
  const client={query:async(sql:string,params:unknown[]=[])=>{
    const r=await db.query(sql,params);return {...r,rowCount:r.rows.length||r.affectedRows||0};
  },release(){}};
  const pool={...client,connect:async()=>client} as unknown as Pool;
  const users=new Map((await db.query<QueryResultRow>("SELECT * FROM users")).rows.map(row=>[row.id,userDTO(row)]));
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{
    req.auth={user:users.get(Number(req.get("x-test-user")||1))!,tokenHash:"test",csrf:"test"};next();
  });
  app.use(legalCaseRoutes(pool));
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    res.status(error instanceof HttpError?error.status:error instanceof ZodError?400:500).json({message:String(error)});
  });
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();});
  const addr=server.address();assert(addr&&typeof addr!=="string");
  async function call(method:string,path:string,body?:unknown,user=1){
    const response=await fetch(`http://127.0.0.1:${addr.port}${path}`,{method,
      headers:{"content-type":"application/json","x-test-user":String(user)},
      body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  const sourceSummary="تفاصيل المصدر الأصلية، وفيها معلومة فريدة وروابط. ".repeat(100);
  const first=await call("POST","/legal/cases",{title:"Original",summary:sourceSummary,
    status:"closed",caseNumber:"50/1447",agency:"جهة محفوظة",caseType:"تجارية",stage:"مرحلة محفوظة",
    fileCopyStatus:"partial",startDate:"2024-01-01",lastHearing:"2026-11-07",nextHearing:"2026-12-07",priority:3,
    driveFolderUrl:"https://drive.google.com/drive/folders/fixture"});
  assert.equal(first.status,201,JSON.stringify(first.data));
  const a=first.data.record.id as number;
  const second=await call("POST","/legal/cases",{title:"Related"});
  const b=second.data.record.id as number;
  const third=await call("POST","/legal/cases",{title:"Private"});
  const c=third.data.record.id as number;
  await db.query("UPDATE legal_cases SET needs_review=true WHERE id=$1",[a]);
  await db.query("INSERT INTO legal_case_access VALUES($1,2,'editor')",[a]);
  await db.exec("INSERT INTO legal_records(id) VALUES(10),(11)");
  await db.query("INSERT INTO legal_record_cases VALUES(10,$1),(11,$2)",[a,c]);
  const profile={executiveSummary:"ملخص إداري موجز",currentAction:"استكمال الصورة",
    organizationalNotes:["صورة الصفحة الأخيرة ناقصة"],
    lastAction:{description:"إجراء مثبت",date:null,sourceRecordIds:[10]},
    proceedingNumbers:[{kind:"حكم",number:"70/1447",sourceRecordIds:[10]}],
    sourceRecordIds:[10],fileKind:"case",currentStatusDescription:"وصف الحالة المثبت وحدوده"};
  const organized=await call("PATCH",`/legal/cases/${a}/organization`,{revision:1,title:"Organized",caseProfile:profile});
  assert.equal(organized.status,200,JSON.stringify(organized.data));
  assert.deepEqual(organized.data.record.case_profile,profile);
  for(const field of ["summary","case_number","agency","case_type","stage","status","file_copy_status",
    "start_date","last_hearing","next_hearing","priority","drive_folder_url"])
    assert.equal(organized.data.record[field],first.data.record[field],field+" must be preserved");
  assert.equal(organized.data.record.needs_review,true);
  assert.equal(organized.data.record.revision,2);
  assert.equal((await call("PATCH",`/legal/cases/${a}/organization`,{revision:1,title:"Stale"})).status,409);
  assert.equal((await call("PATCH",`/legal/cases/${a}/organization`,{revision:2,summary:"Forbidden replacement"})).status,400);
  assert.equal((await call("PATCH",`/legal/cases/${a}/organization`,{revision:2,caseProfile:{...profile,sourceRecordIds:[999]}})).status,400);
  assert.equal((await call("PATCH",`/legal/cases/${a}/organization`,{revision:2,caseProfile:{...profile,sourceRecordIds:[11]}},2)).status,400);
  assert.equal((await call("PATCH",`/legal/cases/${a}/organization`,{revision:2,caseProfile:{...profile,sourceRecordIds:[10,10]}})).status,400);
  const saved=await call("GET",`/legal/cases/${a}`);
  assert.deepEqual(saved.data.record.case_profile,profile);
  assert.equal(saved.data.record.summary,sourceSummary);
  assert.equal(saved.data.record.revision,2);
  const sourceAudit=(await db.query<{before_value:Record<string,unknown>;after_value:Record<string,unknown>}>(
    "SELECT before_value,after_value FROM audit_events WHERE action='legal.update' AND target_type='legalCase' AND target_id=$1",[a])).rows[0]!;
  assert.equal(sourceAudit.before_value.summary,sourceSummary);
  assert.equal(sourceAudit.after_value.summary,sourceSummary);

  const relation={revision:0,relationType:"الدعوى ومرحلة الطعن",evidence:"علاقة مثبتة في المصدر",sourceRecordIds:[10]};
  assert.equal((await call("PUT",`/legal/cases/${a}/relations/${a}`,relation)).status,400);
  assert.equal((await call("PUT",`/legal/cases/${a}/relations/${b}`,relation,2)).status,403);
  const created=await call("PUT",`/legal/cases/${a}/relations/${b}`,relation);
  assert.equal(created.status,200,JSON.stringify(created.data));
  assert.equal(created.data.record.revision,1);
  const fromA=await call("GET",`/legal/cases/${a}/relations`);
  const fromB=await call("GET",`/legal/cases/${b}/relations`);
  assert.equal(fromA.data.items[0].related_case.id,b);
  assert.equal(fromB.data.items[0].related_case.id,a);
  assert.equal(fromA.data.items[0].id,fromB.data.items[0].id);
  assert.equal((await call("PUT",`/legal/cases/${b}/relations/${a}`,relation)).status,409);
  assert.equal((await call("GET",`/legal/cases/${a}/relations`,undefined,2)).data.items.length,0,
    "relationship and the other case must stay hidden without access to both ends");
  assert.equal((await call("GET",`/legal/cases/${b}/relations`,undefined,2)).status,403);
  const ownerExport=await call("GET",`/legal/cases/${a}/ai-export`);
  assert.equal(ownerExport.status,200,JSON.stringify(ownerExport.data));
  assert.deepEqual(ownerExport.data.relations,fromA.data.items);
  const editorExport=await call("GET",`/legal/cases/${a}/ai-export`,undefined,2);
  assert.equal(editorExport.status,200,JSON.stringify(editorExport.data));
  assert.deepEqual(editorExport.data.relations,[]);

  await db.query("INSERT INTO legal_case_access VALUES($1,2,'viewer')",[b]);
  assert.equal((await call("GET",`/legal/cases/${a}/relations`,undefined,2)).data.items.length,1);
  assert.equal((await call("PUT",`/legal/cases/${b}/relations/${a}`,{...relation,revision:1},2)).status,403);
  await db.query("UPDATE legal_case_access SET role='editor' WHERE case_id=$1 AND user_id=2",[b]);
  const changed=await call("PUT",`/legal/cases/${b}/relations/${a}`,{...relation,revision:1,evidence:"دليل العلاقة بعد المراجعة"},2);
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  assert.equal(changed.data.record.revision,2);
  assert.equal((await call("GET",`/legal/cases/${a}/relations`)).data.items[0].evidence,"دليل العلاقة بعد المراجعة");
  assert.equal((await call("PUT",`/legal/cases/${a}/relations/${b}`,{...relation,revision:1})).status,409);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::int n FROM legal_case_relations")).rows[0]!.n,1);
  const afterRelations=await call("GET",`/legal/cases/${a}`);
  assert.equal(afterRelations.data.record.summary,sourceSummary);
  assert.equal(afterRelations.data.record.needs_review,true);
  assert.equal(afterRelations.data.record.revision,2);
  assert.equal((await call("PATCH",`/legal/cases/${a}/organization`,{revision:2,
    caseProfile:{...profile,canonicalCaseId:a}})).status,400);
  assert.equal((await call("PATCH",`/legal/cases/${a}/organization`,{revision:2,
    caseProfile:{...profile,canonicalCaseId:c}},2)).status,403);
  assert.equal((await call("PATCH",`/legal/cases/${a}/organization`,{revision:2,
    caseProfile:{...profile,canonicalCaseId:999}})).status,404);
  const canonical=await call("PATCH",`/legal/cases/${a}/organization`,{revision:2,
    caseProfile:{...profile,canonicalCaseId:b}});
  assert.equal(canonical.status,200,JSON.stringify(canonical.data));
  assert.equal(canonical.data.record.case_profile.canonicalCaseId,b);
  assert.equal(canonical.data.record.summary,sourceSummary);
  assert.equal((await call("PATCH",`/legal/cases/${b}/organization`,{revision:1,
    caseProfile:{...profile,canonicalCaseId:a}})).status,409,"cycles are rejected");
  assert.equal((await call("PATCH",`/legal/cases/${c}/organization`,{revision:1,
    caseProfile:{...profile,canonicalCaseId:a}})).status,409,"new references cannot target a reference");
  assert.equal((await call("PATCH",`/legal/cases/${b}/organization`,{revision:1,
    caseProfile:{...profile,canonicalCaseId:c}})).status,409,"an existing canonical target cannot become a reference");
  await db.exec(`ALTER TABLE legal_records ADD title text DEFAULT '', ADD body text DEFAULT '', ADD content_text text DEFAULT '',
    ADD status text DEFAULT 'pending', ADD due_at timestamptz, ADD assigned_to integer, ADD revision integer DEFAULT 1,
    ADD task_priority integer, ADD task_priority_reason text, ADD created_at timestamptz DEFAULT now(),
    ADD updated_at timestamptz DEFAULT now(), ADD updated_by integer;
    CREATE TABLE legal_task_comments(id integer,task_id integer,body text,created_at timestamptz DEFAULT now());
    INSERT INTO legal_records(id,kind,title,body,due_at,assigned_to) VALUES(12,'task','إحضار الأصل','خطوة محفوظة','2020-01-01',2);
    INSERT INTO legal_record_links VALUES(10,12),(11,12);
    INSERT INTO legal_task_comments(id,task_id,body) VALUES(1,12,'إفادة المتابع');`);
  await db.query("INSERT INTO legal_record_cases VALUES(12,$1)",[a]);
  const board=await call("GET","/legal/tasks",undefined,2);
  assert.equal(board.status,200,JSON.stringify(board.data));
  const task=board.data.items[0];
  assert.equal(task.title,"إحضار الأصل");
  assert.equal(task.body,"خطوة محفوظة");
  assert.equal(task.follow_up_required,true);
  assert.equal(task.due_at.slice(0,10),"2020-01-01");
  assert.deepEqual(task.documents.map((d:{id:number})=>d.id),[10]);
  assert.equal(task.latest_comment,"إفادة المتابع");
  assert.equal(task.assignee_name,"Editor");
  assert.equal((await call("POST","/legal/records/12/task-status",{status:"verified"})).status,400);
  assert.equal((await call("POST","/legal/records/12/task-status",{status:"waiting_source"})).status,200);
  assert.equal((await call("GET","/legal/tasks")).data.items[0].status,"waiting_source");
});
