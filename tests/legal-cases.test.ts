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
 assert.equal((await reporter.call("GET","/legal/cases/"+caseId)).status,403);
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
 const secondCase=await owner.call("POST","/legal/cases",{title:"قضية سرية أخرى"});
 const secondId=secondCase.data.record.id as number;
 assert.equal((await owner.call("POST","/legal/records/"+documentId+"/cases",{caseId:secondId,linked:true})).status,200);
 const scoped=await reporter.call("GET","/legal/cases/"+caseId+"/records");
 assert.equal(scoped.status,200);
 assert.ok(!scoped.data.items.some((x:{id:number})=>x.id===documentId),"shared document must not leak when second case is inaccessible");
});
