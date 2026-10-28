import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";

const databaseUrl=process.env.DATABASE_URL??DEFAULT_DATABASE_URL;
const password="Questions-test-password-2026";
const origin="http://localhost";

class Client {
  cookie="";
  csrf="";
  constructor(readonly base:string){}
  async request<T=any>(method:string,path:string,body?:unknown) {
    const response=await fetch(this.base+"/api"+path,{
      method,
      headers:{
        cookie:this.cookie,
        ...(method==="GET"?{}:{"content-type":"application/json",origin,"x-csrf-token":this.csrf}),
      },
      body:body===undefined?undefined:JSON.stringify(body),
    });
    for(const cookie of response.headers.getSetCookie())
      this.cookie=cookie.split(";")[0]!;
    const data=await response.json() as T;
    if(data && typeof data==="object" && "csrf" in data)
      this.csrf=(data as {csrf:string}).csrf;
    return {status:response.status,data};
  }
  async ok<T=any>(method:string,path:string,body?:unknown,expected=200) {
    const result=await this.request<T>(method,path,body);
    assert.equal(result.status,expected,method+" "+path+": "+JSON.stringify(result.data));
    return result.data;
  }
}

test("questions: variable options, comments, first-answer rewards and company scope",async t=>{
  const schema="question_test_"+randomUUID().replaceAll("-","");
  const runtime=await createApp({databaseUrl,schema,appOrigin:origin,serveStatic:false,production:false});
  const server=runtime.app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const address=server.address();
  assert(address&&typeof address!=="string");
  t.after(async()=>{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await runtime.close();
    const cleanup=new Pool({connectionString:databaseUrl});
    try{await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await cleanup.end();}
  });
  const ownerUser=await provisionOwner(runtime.pool,{name:"Question owner",displayName:"Owner",email:"owner@questions.test",password});
  const owner=new Client(`http://127.0.0.1:${address.port}`);
  await owner.ok("POST","/auth/login",{email:ownerUser.email,password});
  const companyOne=(await owner.ok<{company:{id:number}}>("POST","/companies",{name:"Question company 1",phone:"",address:""},201)).company.id;
  const companyTwo=(await owner.ok<{company:{id:number}}>("POST","/companies",{name:"Question company 2",phone:"",address:""},201)).company.id;
  const base=`/companies/${companyOne}`;
  const two=(await owner.ok<{id:number}>("POST",base+"/questions",{
    category:"مراجعة",priority:2,question:"سؤال من خيارين",options:["خطأ","صحيح"],correctAnswer:2,points:7,active:true,
  },201)).id;
  const list=await owner.ok<{items:{id:number;options:string[];optionCount:number}[]}>("GET",base+"/questions");
  assert.equal(list.items[0]?.id,two);
  assert.equal(list.items[0]?.optionCount,2);
  assert.deepEqual(list.items[0]?.options,["خطأ","صحيح"]);
  assert.equal((await owner.ok<{total:number}>("GET",`/companies/${companyTwo}/questions`)).total,0);
  assert.equal((await owner.request("POST",`${base}/questions/${two}/answers`,
    {selectedAnswer:3,idempotencyKey:randomUUID()})).status,400);

  const firstKey=randomUUID();
  const firstInput={selectedAnswer:1,comment:"تعليق المحاولة الأولى",idempotencyKey:firstKey};
  const first=await owner.ok<{correct:boolean;points:number;firstAttempt:boolean;id:string}>(
    "POST",`${base}/questions/${two}/answers`,firstInput,201);
  assert.equal(first.firstAttempt,true);
  assert.equal(first.correct,false);
  assert.equal(first.points,0);
  const retried=await owner.ok<{id:string;points:number}>(
    "POST",`${base}/questions/${two}/answers`,firstInput);
  assert.equal(retried.id,first.id);
  const again=await owner.ok<{correct:boolean;firstAttempt:boolean;points:number}>(
    "POST",`${base}/questions/${two}/answers`,
    {selectedAnswer:2,comment:"الإجابة صحيحة الآن",idempotencyKey:randomUUID()},201);
  assert.equal(again.correct,true);
  assert.equal(again.firstAttempt,false);
  assert.equal(again.points,0);

  const four=(await owner.ok<{id:number}>("POST",base+"/questions",{
    category:"اختبار",priority:1,question:"سؤال من أربعة",
    options:["أ","ب","ج","د"],correctAnswer:4,points:5,active:true,
  },201)).id;
  const rewarded=await owner.ok<{points:number;firstAttempt:boolean}>(
    "POST",`${base}/questions/${four}/answers`,
    {selectedAnswer:4,idempotencyKey:randomUUID()},201);
  assert.equal(rewarded.firstAttempt,true);
  assert.equal(rewarded.points,5);
  const noReward=await owner.ok<{points:number}>(
    "POST",`${base}/questions/${four}/answers`,
    {selectedAnswer:4,idempotencyKey:randomUUID()},201);
  assert.equal(noReward.points,0);

  const answerList=await owner.ok<{total:number;items:{comment:string|null;questionId:number;points:number}[]}>(
    "GET",base+"/answers?pageSize=10");
  assert.equal(answerList.total,4);
  assert(answerList.items.some(item=>item.comment==="تعليق المحاولة الأولى"));
  assert(answerList.items.some(item=>item.questionId===four&&item.points===5));
  const publicQuestion=(await owner.ok<{id:number}>("POST","/questions",{
    category:"عام",priority:1,question:"سؤال من ثلاثة",options:["1","2","3"],correctAnswer:1,points:1,active:true,
  },201)).id;
  const publicList=await owner.ok<{items:{id:number;optionCount:number}[]}>("GET","/questions");
  assert(publicList.items.some(q=>q.id===publicQuestion&&q.optionCount===3));
  assert.equal((await owner.ok<{total:number}>("GET","/answers")).total,0);

  const member=new Client(owner.base);
  await member.ok("POST","/auth/register",{
    name:"Question member",displayName:"Member",email:"member@questions.test",phone:"",password,
  },201);
  const ownPublic=await member.ok<{items:{correctAnswer:number|null}[]}>("GET","/questions");
  assert.equal(ownPublic.items[0]?.correctAnswer,null);
  assert.equal((await member.request("POST","/questions",{
    question:"غير مصرح",options:["1","2"],correctAnswer:1,
  })).status,403);
  assert.equal((await member.request("GET",base+"/questions")).status,403);
});
