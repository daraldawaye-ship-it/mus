import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";
import { legalCaseRoutes } from "../apps/api/src/routes-legal-cases.ts";
import { HttpError } from "../apps/api/src/errors.ts";
import { ZodError } from "zod";
test("catalog advertises document review updates and filters",()=>{
 const router=legalCaseRoutes({} as Pool);
 const list=apiCatalog(router,{operation:"GET /legal/records"}).operations[0];
 const put=apiCatalog(router,{operation:"PUT /legal/records/:id"}).operations[0];
 const patch=apiCatalog(router,{operation:"PATCH /legal/records/:id/work-status"}).operations[0];
 assert.ok(list && "queryFields" in list);
 assert.deepEqual(list.queryFields,["kind","q","page","unlinked","compact","caseId","manual","priority","imageState","transcriptionState","importanceScore","importanceOrder","automationWork","manualWork"]);
 assert.ok(put && "bodySchema" in put);
 assert.ok(put.bodySchema && JSON.stringify(put.bodySchema).includes("\"documentReview\""));
 assert.ok(JSON.stringify(put.bodySchema).includes("\"importanceScore\""));
 assert.ok(patch && "bodySchema" in patch);
 assert.ok(JSON.stringify(patch.bodySchema).includes("\"automationWorkStatus\""));
 assert.ok(JSON.stringify(patch.bodySchema).includes("\"manualWorkStatus\""));
});

test("legal document reviews stay revision-safe and manual queue excludes resolved and duplicate records",async t=>{
 const db=new PGlite();
 await db.exec(`
  CREATE TABLE users(id integer PRIMARY KEY,name text,display_name text,email text,phone text,image text,kind text,
    owner boolean DEFAULT false,archived boolean DEFAULT false,suspended boolean DEFAULT false,editor boolean DEFAULT false,monitor boolean DEFAULT false,created_at timestamptz DEFAULT now());
  INSERT INTO users(id,name,display_name,kind,owner) VALUES (1,'Owner','Owner','admin',true),(2,'Viewer','Viewer','member',false);
  CREATE TABLE general_table(general_table_id integer PRIMARY KEY);
  CREATE TABLE legal_case_access(case_id integer,user_id integer,role text);
  INSERT INTO legal_case_access VALUES(1,2,'viewer');
  CREATE TABLE legal_record_cases(record_id integer,case_id integer);
  INSERT INTO legal_record_cases VALUES(1,1),(2,1),(3,1),(4,2),(5,1);
  CREATE TABLE legal_record_links(first_record_id integer,second_record_id integer);
  INSERT INTO legal_record_links VALUES(1,3),(4,5);
  CREATE TABLE legal_document_images(id integer PRIMARY KEY,record_id integer,filename text,created_at timestamptz DEFAULT now());
  INSERT INTO legal_document_images(id,record_id,filename) VALUES(100,1,'original.webp'),(400,4,'private.webp');
  CREATE TABLE page_settings(page_key text,company_id integer,enabled boolean);
  CREATE TABLE audit_events(actor_id integer,actor_name text,scope text,company_id integer,action text,target_type text,target_id integer,before_value jsonb,after_value jsonb);
 `);
 const initial=await readFile("apps/api/migrations/118_legal_case_management.sql","utf8");
 await db.exec(initial.match(/CREATE TABLE legal_cases \([\s\S]+?\n\);/)![0]);
 await db.exec(initial.match(/CREATE TABLE legal_records \([\s\S]+?\n\);/)![0]);
 await db.exec("ALTER TABLE legal_records ADD COLUMN transcription_status text, ADD COLUMN transcription_file boolean DEFAULT false;");
 const migration=await readFile("apps/api/migrations/20261119_zz_legal_document_review.sql","utf8");
 await db.exec(migration);await db.exec(migration);
 const tagged=JSON.stringify({sourceFilename:"p17.pdf",sourcePage:17,hearingGroup:"مجموعة مؤكدة",priority:"high",manualTranscription:true,missingPassage:"منطوق القرار"});
 await db.exec(`
  INSERT INTO legal_cases(title,created_by,updated_by) VALUES('Visible case',1,1),('Private case',1,1);
  INSERT INTO legal_records(kind,title,body,content_text,created_by,updated_by,transcription_status) VALUES
    ('document','Original','body','transcript',1,1,'partial'),
    ('document','Resolved','','',1,1,'complete'),
    ('document','Duplicate','','',1,1,'duplicate'),
    ('document','Private original','','',1,1,'partial'),
    ('document','Public reference','body mention #1 869','',1,1,'partial');
 `);
 await db.query("UPDATE legal_records SET document_review=$1 WHERE id<=4",[tagged]);
 await db.exec(`UPDATE legal_records SET document_review=document_review||'{"canonicalRecordId":1}'::jsonb WHERE id=3;
  UPDATE legal_records SET document_review='{"canonicalRecordId":4}'::jsonb WHERE id=5;`);
 const query=async(sql:string,params:unknown[]=[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const app=express();app.use(express.json());
 app.use((req,_res,next)=>{const id=Number(req.get("x-user")??1);req.auth={user:{id,displayName:"User",owner:id===1,suspended:false,kind:"member"} as User,tokenHash:"test",csrf:"test"};next();});
 app.use("/api",legalCaseRoutes({query,connect:async()=>({query,release(){}})} as unknown as Pool));
 app.use(((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  res.status(err instanceof HttpError?err.status:err instanceof ZodError?400:500).json({error:String(err)});
 }) as express.ErrorRequestHandler);
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();});
 const addr=server.address();assert.ok(addr&&typeof addr!=="string");
 const call=async(path:string,user=1,body?:unknown,method=body===undefined?"GET":"PUT")=>{
  const r=await fetch(`http://127.0.0.1:${addr.port}/api/legal${path}`,{method,headers:{"Content-Type":"application/json","x-user":String(user)},body:JSON.stringify(body)});
  return {status:r.status,data:await r.json()};
 };
 const queued=await call("/records?kind=document&manual=true&caseId=1&compact=true",2);
 assert.equal(queued.status,200,JSON.stringify(queued.data));
 assert.equal(queued.data.total,1);assert.equal(queued.data.items[0].id,1);
 assert.equal(queued.data.items[0].document_image_state,"internal");
 assert.deepEqual(queued.data.items[0].document_case_ids,[1]);
 assert.equal((await call("/records?kind=document&manual=true&caseId=2",2)).status,403);
 for(const q of ["#1","# 1","#١","#۱"]){
  const found=await call("/records?kind=document&manual=true&caseId=1&q="+encodeURIComponent(q),2);
  assert.equal(found.status,200,JSON.stringify(found.data));
  assert.deepEqual(found.data.items.map((r:{id:number})=>r.id),[1]);
 }
 assert.equal((await call("/records?kind=document&q=%234",2)).data.total,0);
 assert.equal((await call("/records?kind=document&manual=true&q=%232",2)).data.total,0);
 assert.equal((await call("/records?kind=document&caseId=1&q=%234",1)).data.total,0);
 assert.equal((await call("/records?kind=document&q=Original",2)).data.items[0].id,1);
 assert.deepEqual((await call("/records?kind=document&q=5",2)).data.items.map((r:{id:number})=>r.id),[5]);
 assert.deepEqual((await call("/records?kind=document&q=869",2)).data.items.map((r:{id:number})=>r.id),[5]);
 assert.equal((await call("/records?kind=document&q=%23869",2)).data.total,0);
 assert.equal((await call("/records?kind=document&manual=true&q=p17.pdf",2)).data.total,1);
 const filtered=await call("/records?kind=document&imageState=canonical&transcriptionState=duplicate",2);
 assert.equal(filtered.status,200,JSON.stringify(filtered.data));assert.equal(filtered.data.total,1);
 assert.deepEqual(filtered.data.items.map((i:{id:number;document_image_id:number})=>[i.id,i.document_image_id]),[[3,100]]);
 const hidden=await call("/records/5",2);
 assert.equal(hidden.status,200,JSON.stringify(hidden.data));
 assert.equal(hidden.data.record.document_image_state,"unverified");assert.equal(hidden.data.record.document_image_id,null);
 const previous=await call("/records/1");const prev=previous.data.record;
 const payload={kind:"document",title:prev.title,body:prev.body,contentText:prev.content_text,revision:prev.revision};
 const unchanged=await call("/records/1",1,payload);assert.equal(unchanged.status,200,JSON.stringify(unchanged.data));
 assert.deepEqual(unchanged.data.record.document_review,prev.document_review);
 assert.equal((await call("/records/1",1,payload)).status,409);
 const rev=unchanged.data.record.revision;
 const bad=await call("/records/1",1,{...payload,revision:rev,documentReview:{priority:"high",manualTranscription:true}});
 assert.equal(bad.status,400);
 const unlinked=await call("/records/1",1,{...payload,revision:rev,documentReview:{canonicalRecordId:4}});
 assert.equal(unlinked.status,400);
 const revised=await call("/records/1",1,{...payload,revision:rev,documentReview:{...prev.document_review,verifiedOn:"2026-11-19"}});
 assert.equal(revised.status,200,JSON.stringify(revised.data));assert.equal(revised.data.record.document_review.verifiedOn,"2026-11-19");
 const scoreUpdate=await call("/records/1",1,{...payload,revision:revised.data.record.revision,documentReview:{...prev.document_review,priority:undefined,importanceScore:10}});
 assert.equal(scoreUpdate.status,200,JSON.stringify(scoreUpdate.data));
 assert.equal(scoreUpdate.data.record.document_review.importanceScore,10);
 for(const invalid of [0,1.5,-1,11,"1"]){
  const rejected=await call("/records/1",1,{...payload,revision:scoreUpdate.data.record.revision,documentReview:{...prev.document_review,importanceScore:invalid}});
  assert.equal(rejected.status,400,JSON.stringify(rejected.data));
 }
 await db.query("UPDATE legal_records SET document_review=document_review||$1::jsonb WHERE id=4",[JSON.stringify({importanceScore:2})]);
 await db.query("UPDATE legal_records SET document_review=$1 WHERE id=5",[JSON.stringify({...prev.document_review,priority:undefined,importanceScore:3})]);
 const unranked=await db.query<{id:number}>("INSERT INTO legal_records(kind,title,created_by,updated_by,transcription_status,document_review) VALUES('document','Unranked',1,1,'partial',$1) RETURNING id",[JSON.stringify(prev.document_review)]);
 await db.query("INSERT INTO legal_record_cases VALUES($1,1)",[unranked.rows[0].id]);
 const order=await call("/records?kind=document&manual=true&compact=true&importanceOrder=desc");
 assert.deepEqual(order.data.items.map((r:{id:number})=>r.id),[1,5,4,unranked.rows[0].id]);
 const scoped=await call("/records?kind=document&manual=true&caseId=1&importanceOrder=desc",2);
 assert.deepEqual(scoped.data.items.map((r:{id:number})=>r.id),[1,5,unranked.rows[0].id]);
 const usual=await call("/records?kind=document&manual=true&caseId=1",2);
 assert.deepEqual(usual.data.items.map((r:{id:number})=>r.id),[unranked.rows[0].id,5,1]);
 const asc=await call("/records?kind=document&manual=true&caseId=1&importanceOrder=asc",2);
 assert.deepEqual(asc.data.items.map((r:{id:number})=>r.id),[5,1,unranked.rows[0].id]);
 const ordinary=await call("/records?kind=document&importanceScore=3&importanceOrder=desc",2);
 assert.deepEqual(ordinary.data.items.map((r:{id:number})=>r.id),[5]);
 assert.equal((await call("/records?kind=document&importanceOrder=middle",2)).status,400);
 assert.deepEqual((await call("/records?kind=document&manual=true&importanceScore=3",2)).data.items.map((r:{id:number})=>r.id),[5]);
 assert.deepEqual((await call("/records?kind=document&manual=true&importanceScore=unrated",2)).data.items.map((r:{id:number})=>r.id),[unranked.rows[0].id]);
 assert.equal((await call("/records?kind=document&importanceScore=11",2)).status,400);
 const idSearch=await call("/records?kind=document&manual=true&q=%231",2);
 assert.deepEqual(idSearch.data.items.map((r:{id:number})=>r.id),[1]);
 const bulk=JSON.stringify({...prev.document_review,priority:undefined,importanceScore:5});
 await db.query("WITH added AS (INSERT INTO legal_records(kind,title,created_by,updated_by,transcription_status,document_review) SELECT 'document','Bulk '||n,1,1,'partial',$1 FROM generate_series(1,101) n RETURNING id) INSERT INTO legal_record_cases SELECT id,1 FROM added",[bulk]);
 const firstPage=await call("/records?kind=document&manual=true&caseId=1&importanceOrder=desc&page=1",2);
 const secondPage=await call("/records?kind=document&manual=true&caseId=1&importanceOrder=desc&page=2",2);
 assert.equal(firstPage.data.items.length,100);assert.equal(firstPage.data.items[0].id,1);
 assert.equal(secondPage.data.items.at(-1).id,unranked.rows[0].id);
 assert.equal(new Set([...firstPage.data.items,...secondPage.data.items].map((r:{id:number})=>r.id)).size,104);
 const record2=(await call("/records/2")).data.record;
 const statusPatch={revision:record2.revision,automationWorkStatus:"completed",manualWorkStatus:"none"};
 assert.equal((await call("/records/2/work-status",2,statusPatch,"PATCH")).status,403);
 const changed=await call("/records/2/work-status",1,statusPatch,"PATCH");
 assert.equal(changed.status,200,JSON.stringify(changed.data));
 assert.equal(changed.data.record.document_review.sourcePage,17);
 assert.equal(changed.data.record.document_review.automationWorkStatus,"completed");
 assert.equal(changed.data.record.document_review.manualWorkStatus,"none");
 assert.equal((await call("/records/2/work-status",1,statusPatch,"PATCH")).status,409);
 const combined=await call("/records?kind=document&compact=true&automationWork=completed&manualWork=none",2);
 assert.equal(combined.status,200,JSON.stringify(combined.data));
 assert.equal(combined.data.total,1);
 assert.deepEqual(combined.data.items.map((r:{id:number})=>r.id),[2]);
 const stillPending=(await call("/records/1")).data.record;
 assert.equal((await call("/records/1/work-status",1,{revision:stillPending.revision,manualWorkStatus:"none"},"PATCH")).status,409);
 assert.equal((await call("/records?kind=document&manualWork=invented",2)).status,400);
});
