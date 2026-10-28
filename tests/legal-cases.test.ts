import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
const databaseUrl=process.env.DATABASE_URL;
test("case archive migration, owner, delegated reports, links and AI export",async t=>{
 if(!databaseUrl){t.skip("DATABASE_URL required for database integration");return;}
 const schema="legal_ci_"+randomUUID().replaceAll("-","");
 const run=await createApp({databaseUrl,schema,appOrigin:"http://localhost",production:false,serveStatic:false});
 const server:Server=run.app.listen(0,"127.0.0.1");
 await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
 const addr=server.address();
 assert(addr&&typeof addr!=="string");
 const base="http://127.0.0.1:"+addr.port;
 t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await run.close();const pool=new Pool({connectionString:databaseUrl});try{await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}finally{await pool.end();}});
 await provisionOwner(run.pool,{name:"Test Owner",displayName:"Test Owner",email:"owner-legal@test.example",password:"LegalTest-passphrase-2026"});
 class Client {
  cookie="";csrf="";
  async call(method:string,path:string,body?:unknown){
   const headers=new Headers({"Accept":"application/json"});
   if(this.cookie)headers.set("Cookie",this.cookie);
   if(method!=="GET"){headers.set("Origin","http://localhost");headers.set("Content-Type","application/json");if(this.csrf)headers.set("X-CSRF-Token",this.csrf);}
   const response=await fetch(base+"/api"+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   for(const v of response.headers.getSetCookie()){if(!/max-age=0/i.test(v))this.cookie=v.split(";",1)[0]!;}
   const text=await response.text();const data=text?JSON.parse(text):{};
   if(typeof data?.csrf==="string")this.csrf=data.csrf;
   return {status:response.status,data};
  }
 }
 const owner=new Client(),reporter=new Client();
 assert.equal((await owner.call("POST","/auth/login",{email:"owner-legal@test.example",password:"LegalTest-passphrase-2026"})).status,200);
 const registered=await reporter.call("POST","/auth/register",{name:"Yemen",displayName:"Yemen",email:"yemen-legal@test.example",phone:"",password:"LegalReporterPass-2026"});
 assert.equal(registered.status,201,JSON.stringify(registered.data));
 const reportUserId=registered.data.user.id as number;
 const created=await owner.call("POST","/legal/cases",{title:"قضية اختبار ناتكو",priority:9});
 assert.equal(created.status,201,JSON.stringify(created.data));
 const caseId=created.data.record.id as number;
 const urgentCase=await owner.call("POST","/legal/cases",{title:"قضية أولوية قصوى",priority:1});
 const unrankedCase=await owner.call("POST","/legal/cases",{title:"قضية دون أولوية"});
 assert.equal(urgentCase.status,201);
 assert.equal(unrankedCase.status,201);
 const sortedCases=await owner.call("GET","/legal/cases");
 assert.deepEqual(sortedCases.data.items.map((c:{id:number})=>c.id).filter((i:number)=>[urgentCase.data.record.id,caseId,unrankedCase.data.record.id].includes(i)),[urgentCase.data.record.id,caseId,unrankedCase.data.record.id],"case priorities follow tasks: 1 first, 0 last");
 assert.equal((await reporter.call("GET","/legal/cases/"+caseId)).status,403);
 assert.equal((await reporter.call("GET",commentsPath)).status,403);
 assert.equal((await reporter.call("POST",commentsPath,{body:"بعد سحب الصلاحية"})).status,403);
 assert.equal((await reporter.call("GET","/legal/cases/"+caseId+"/ai-export")).status,403);
 const beforeGrant=await reporter.call("GET","/legal/cases");
 assert.equal(beforeGrant.status,200);
 assert.equal(beforeGrant.data.total,0);
 assert.equal((await reporter.call("PUT","/legal/cases/"+caseId+"/access",{userId:reportUserId,role:"editor"})).status,403);
 assert.equal((await owner.call("PUT","/legal/cases/"+caseId+"/access",{userId:reportUserId,role:"reporter"})).status,200);
 assert.equal((await reporter.call("GET","/legal/cases/"+caseId)).status,200);
 const newReport=await reporter.call("POST","/legal/records",{kind:"report",title:"تقرير المتابعة الأول",body:"راجعت المحكمة",caseIds:[caseId]});
 assert.equal(newReport.status,201,JSON.stringify(newReport.data));
 assert.equal((await reporter.call("POST","/legal/records",{kind:"document",title:"غير مسموح",caseIds:[caseId]})).status,403);
 const newDocument=await owner.call("POST","/legal/records",{kind:"document",title:"مستند أصلي",contentText:"النص الأصلي كما هو",pdfUrl:"https://drive.google.com/file/d/example/view",caseIds:[caseId]});
 assert.equal(newDocument.status,201,JSON.stringify(newDocument.data));
 const documentId=newDocument.data.record.id as number,reportId=newReport.data.record.id as number;
 assert.equal((await owner.call("POST","/legal/records/"+reportId+"/links",{otherId:documentId,linked:true})).status,200);
 const exportResult=await owner.call("GET","/legal/cases/"+caseId+"/ai-export");
 assert.equal(exportResult.status,200);
 assert.ok(exportResult.data.records.some((x:{id:number;content_text:string})=>x.id===documentId&&x.content_text==="النص الأصلي كما هو"));
 assert.equal((await owner.call("POST","/legal/records/"+reportId+"/review")).status,200);
 // Orphan reviews must only list records not connected to ANY case, with paging.
 const orphan=await owner.call("POST","/legal/records",{kind:"fact",title:"معطى لم يرتبط بقضية",caseIds:[]});
 assert.equal(orphan.status,201);
 const orphanList=await owner.call("GET","/legal/records?unlinked=true&page=1");
 assert.equal(orphanList.status,200,JSON.stringify(orphanList.data));
 assert.equal(orphanList.data.total,1);
 assert.deepEqual(orphanList.data.items.map((x:{id:number})=>x.id),[orphan.data.record.id]);
 assert.equal(orphanList.data.pageSize,30);
 const nextOrphanPage=await owner.call("GET","/legal/records?unlinked=true&page=2");
 assert.equal(nextOrphanPage.status,200);
 assert.equal(nextOrphanPage.data.items.length,0);
 assert.equal((await owner.call("GET","/legal/records?unlinked=maybe")).status,400);
 assert.equal((await owner.call("GET","/legal/records?unlinked=true&page=0")).status,400);
 assert.equal((await reporter.call("GET","/legal/records?unlinked=true")).status,403);
 const orphanSearch=await owner.call("GET","/legal/records?unlinked=true&q="+encodeURIComponent("لم يرتبط"));
 assert.deepEqual(orphanSearch.data.items.map((x:{id:number})=>x.id),[orphan.data.record.id]);
 const secondCase=await owner.call("POST","/legal/cases",{title:"قضية سرية أخرى"});
 const secondId=secondCase.data.record.id as number;
 assert.equal((await owner.call("POST","/legal/records/"+documentId+"/cases",{caseId:secondId,linked:true})).status,200);
 const scoped=await reporter.call("GET","/legal/cases/"+caseId+"/records");
 assert.equal(scoped.status,200);
 assert.ok(!scoped.data.items.some((x:{id:number})=>x.id===documentId),"shared document must not leak when second case is inaccessible");

 // The current task board uses calculated per-task priorities, independently of
 // the legacy order of case records. A single edit must never renumber peers.
 const task=async(title:string,extra:Record<string,unknown>={})=>{
  const result=await owner.call("POST","/legal/records",{kind:"task",title,caseIds:[caseId],...extra});
  assert.equal(result.status,201,JSON.stringify(result.data));
  return result.data.record as {id:number;revision:number};
 };
 const overdue=await task("موعد مسجل فائت",{dueAt:"2000-01-01T00:00:00Z",sortOrder:999});
 const ordinary=await task("متابعة عادية",{sortOrder:0});
 const near=await task("موعد قريب",{dueAt:new Date(Date.now()+86400000).toISOString()});
 const done=await task("[أولوية 1] مهمة منجزة",{status:"verified"});
 const unlinked=await task("مهمة خاصة بالمالك",{caseIds:[]});
 const hiddenCase=await owner.call("POST","/legal/cases",{title:"محبوسية تحتاج متابعة"});
 assert.equal(hiddenCase.status,201);
 const shared=await task("متابعة مشتركة",{caseIds:[caseId,hiddenCase.data.record.id]});
 const escaped=await task("بحث%_\\نص",{caseIds:[]});
 const search=await owner.call("GET","/legal/tasks?q="+encodeURIComponent("%_\\"));
 assert.equal(search.status,200,JSON.stringify(search.data));
 assert.deepEqual(search.data.items.map((x:{id:number})=>x.id),[escaped.id],"search metacharacters are literal");
 const initialBoard=await owner.call("GET","/legal/tasks");
 assert.equal(initialBoard.status,200,JSON.stringify(initialBoard.data));
 assert.equal(initialBoard.data.items[0].id,overdue.id);
 assert.equal(initialBoard.data.items.find((x:{id:number})=>x.id===shared.id).priority,4,"all linked case titles contribute to urgency");
 const visibleBoard=await reporter.call("GET","/legal/tasks");
 assert.equal(visibleBoard.status,200);
 // A task comment is an attributed, append-only progress note. Readers may
 // comment on tasks they can see, but not tasks in inaccessible/partial cases.
 const commentsPath="/legal/tasks/"+ordinary.id+"/comments";
 assert.equal((await reporter.call("GET",commentsPath)).status,200);
 assert.equal((await reporter.call("POST",commentsPath,{body:"  "})).status,400);
 assert.equal((await reporter.call("POST",commentsPath,{body:"x".repeat(2001)})).status,400);
 const firstComment=await reporter.call("POST",commentsPath,{body:"تمت مراجعة المحكمة وتسليم المذكرة"});
 assert.equal(firstComment.status,201,JSON.stringify(firstComment.data));
 assert.equal(firstComment.data.comment.user_id,reportUserId);
 assert.equal(firstComment.data.comment.user_name,"Yemen");
 const ownerComment=await owner.call("POST",commentsPath,{body:"تم توجيه المحامي للمتابعة"});
 assert.equal(ownerComment.status,201,JSON.stringify(ownerComment.data));
 const commentList=await reporter.call("GET",commentsPath);
 assert.equal(commentList.status,200,JSON.stringify(commentList.data));
 assert.equal(commentList.data.total,2);
 assert.deepEqual(commentList.data.items.map((x:{body:string})=>x.body),
   ["تم توجيه المحامي للمتابعة","تمت مراجعة المحكمة وتسليم المذكرة"]);
 assert.equal(commentList.data.items[1].user_name,"Yemen");
 assert.equal((await reporter.call("GET",commentsPath+"?page=0")).status,400);
 assert.equal((await reporter.call("GET","/legal/tasks/"+shared.id+"/comments")).status,403);
 assert.equal((await reporter.call("POST","/legal/tasks/"+shared.id+"/comments",{body:"محجوب"})).status,403);
 assert.equal((await reporter.call("GET","/legal/tasks/"+unlinked.id+"/comments")).status,403);
 assert.equal((await reporter.call("POST","/legal/tasks/"+reportId+"/comments",{body:"ليس مهمة"})).status,400);
 const withComments=await owner.call("GET","/legal/tasks");
 assert.equal(withComments.data.items.find((r:{id:number})=>r.id===ordinary.id).comment_count,2);
 const commentAudit=await run.pool.query(
   "SELECT count(*)::int AS n FROM audit_events WHERE action='legal.task.comment' AND target_type='legalTask' AND target_id=$1",
   [ordinary.id]);
 assert.equal(commentAudit.rows[0].n,2);
 for(const hidden of [shared.id,unlinked.id,escaped.id])
  assert.ok(!visibleBoard.data.items.some((x:{id:number})=>x.id===hidden),"partial case access must not expose task or priority facts");
 const currentCase=await owner.call("GET","/legal/cases/"+caseId+"/records");
 assert.equal(currentCase.status,200);
 assert.deepEqual(currentCase.data.items.filter((x:{kind:string})=>x.kind==="task").map((x:{id:number})=>x.id),[overdue.id,near.id,shared.id,ordinary.id,done.id]);
 const peerBefore=(await run.pool.query("SELECT * FROM legal_records WHERE id=$1",[overdue.id])).rows[0];
 const priorityPath="/legal/tasks/"+ordinary.id+"/priority";
 assert.equal((await reporter.call("PUT",priorityPath,{priority:1,revision:ordinary.revision})).status,403);
 assert.equal((await owner.call("PUT",priorityPath,{priority:1})).status,400);
 assert.equal((await owner.call("PUT",priorityPath,{priority:11,revision:ordinary.revision})).status,400);
 const changed=await owner.call("PUT",priorityPath,{priority:1,reason:"عاجلة بقرار المالك",revision:ordinary.revision});
 assert.equal(changed.status,200,JSON.stringify(changed.data));
 assert.equal(changed.data.record.task_priority,1);
 assert.equal(changed.data.record.task_priority_reason,"عاجلة بقرار المالك");
 assert.equal(changed.data.record.revision,ordinary.revision+1);
 const manualBoard=await owner.call("GET","/legal/tasks");
 assert.equal(manualBoard.data.items[0].id,ordinary.id);
 assert.equal(manualBoard.data.items[0].source,"manual");
 const manualCase=await owner.call("GET","/legal/cases/"+caseId+"/records");
 assert.equal(manualCase.data.items.find((x:{kind:string})=>x.kind==="task").id,ordinary.id,"case tasks share board priority order");
 const stale=await owner.call("PUT",priorityPath,{priority:10,revision:ordinary.revision});
 assert.equal(stale.status,409,"stale priority must not replace a newer edit");
 const stored=await owner.call("GET","/legal/records/"+ordinary.id);
 assert.equal(stored.data.record.task_priority,1);
 const reset=await owner.call("PUT",priorityPath,{priority:null,reason:"ignored on reset",revision:changed.data.record.revision});
 assert.equal(reset.status,200);
 assert.equal(reset.data.record.task_priority,null);
 assert.equal(reset.data.record.task_priority_reason,"");
 const resetBoard=await owner.call("GET","/legal/tasks");
 assert.equal(resetBoard.data.items.find((x:{id:number})=>x.id===ordinary.id).source,"automatic");
 assert.equal(resetBoard.data.items.find((x:{id:number})=>x.id===ordinary.id).priority,9);
 assert.equal(resetBoard.data.items[0].id,overdue.id);
 assert.deepEqual((await run.pool.query("SELECT * FROM legal_records WHERE id=$1",[overdue.id])).rows[0],peerBefore,"editing one priority preserves every peer field");
 const priorityAudit=await run.pool.query("SELECT before_value,after_value FROM audit_events WHERE target_type='legalRecord' AND target_id=$1 AND action='legal.update' ORDER BY id",[ordinary.id]);
 assert.equal(priorityAudit.rows.length,2,"only accepted edits are audited");
 assert.equal(priorityAudit.rows[0].before_value.task_priority,null);
 assert.equal(priorityAudit.rows[0].after_value.task_priority,1);
 assert.equal(priorityAudit.rows[1].after_value.task_priority,null);
 // Generate newer routine records so the older urgent task lies beyond the old
 // newest-1000 cutoff. Ranking must include it and report the real visible count.
 await run.pool.query("INSERT INTO legal_records(kind,title,created_by,updated_by) SELECT 'task','متابعة إضافية '||n,$1,$1 FROM generate_series(1,1001) n",[changed.data.record.created_by]);
 const completeBoard=await owner.call("GET","/legal/tasks");
 assert.equal(completeBoard.status,200);
 assert.equal(completeBoard.data.items[0].id,overdue.id);
 assert.equal(completeBoard.data.total,1001+initialBoard.data.total);
 assert.equal(completeBoard.data.items.at(-1).id,done.id,"completed tasks stay after pending tasks");
 const visibleCase=await reporter.call("GET","/legal/cases/"+caseId+"/records");
 assert.ok(!visibleCase.data.items.some((x:{id:number})=>x.id===shared.id));
 assert.equal((await owner.call("PUT","/legal/cases/"+caseId+"/access",{userId:reportUserId,role:null})).status,200);
 assert.equal((await reporter.call("GET","/legal/cases/"+caseId)).status,403);
 const afterRevocation=await reporter.call("GET","/legal/cases");
 assert.equal(afterRevocation.status,200);
 assert.equal(afterRevocation.data.total,0);
 assert.equal((await owner.call("GET","/legal/cases/"+caseId)).status,200);
});
