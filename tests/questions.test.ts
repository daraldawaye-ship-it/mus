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
  const companyCategories=await owner.ok<{items:{category:string;count:number}[]}>("GET",base+"/questions/categories");
  assert.deepEqual(companyCategories.items,[{category:"مراجعة",count:1}]);
  const emptyCompanyCategories=await owner.ok<{items:unknown[]}>("GET",`/companies/${companyTwo}/questions/categories`);
  assert.deepEqual(emptyCompanyCategories.items,[]);
  assert.equal((await owner.ok<{total:number}>("GET",base+"/questions?category="+encodeURIComponent("مراجعة"))).total,1);
  assert.equal((await owner.ok<{total:number}>("GET",base+"/questions?category="+encodeURIComponent("معلومات صيدلانية"))).total,0);
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
  const twoCompanyCategories=await owner.ok<{items:{category:string;count:number}[]}>("GET",base+"/questions/categories");
  assert.deepEqual(twoCompanyCategories.items,[
    {category:"اختبار",count:1},{category:"مراجعة",count:1}
  ]);
  const onlyTest=await owner.ok<{total:number;items:{id:number}[]}>(
    "GET",base+"/questions?category="+encodeURIComponent("اختبار"));
  assert.equal(onlyTest.total,1);
  assert.equal(onlyTest.items[0]?.id,four);
  assert.equal((await owner.request("GET",base+"/questions?category="+("x".repeat(121)))).status,400);

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
  const publicCategories=await owner.ok<{items:{category:string;count:number}[]}>("GET","/questions/categories");
  assert.deepEqual(publicCategories.items,[{category:"عام",count:1}]);
  assert.equal((await owner.ok<{total:number}>("GET","/questions?category="+encodeURIComponent("عام"))).total,1);
  assert.equal((await owner.ok<{total:number}>("GET","/questions?category="+encodeURIComponent("مراجعة"))).total,0);
  // Newly created categories appear without hardcoding menu entries.
  await owner.ok("POST","/questions",{
    category:"معلومات صيدلانية",priority:2,question:"دواء تجريبي",options:["نعم","لا"],
    correctAnswer:1,points:1,active:true,
  },201);
  await owner.ok("POST","/questions",{
    category:"فئة مستقبلية",priority:2,question:"سؤال مؤجل",
    options:["نعم","لا"],correctAnswer:1,points:1,active:false,
  },201);
  const expandedCategories=await owner.ok<{items:{category:string;count:number}[]}>("GET","/questions/categories");
  assert.deepEqual(expandedCategories.items,[
    {category:"معلومات صيدلانية",count:1},
    {category:"عام",count:1},
    {category:"فئة مستقبلية",count:1},
  ]);
  const publicPharmacy=await owner.ok<{items:{category:string;question:string}[];total:number}>(
    "GET","/questions?category="+encodeURIComponent("معلومات صيدلانية"));
  assert.equal(publicPharmacy.total,1);
  assert.equal(publicPharmacy.items[0]?.question,"دواء تجريبي");

  const member=new Client(owner.base);
  await member.ok("POST","/auth/register",{
    name:"Question member",displayName:"Member",email:"member@questions.test",phone:"",password,
  },201);
  const memberCategories=await member.ok<{items:{category:string;count:number}[]}>("GET","/questions/categories");
  assert.deepEqual(memberCategories.items,[
    {category:"معلومات صيدلانية",count:1},{category:"عام",count:1}
  ]);
  assert.equal((await member.request("GET",base+"/questions/categories")).status,403);
  const ownPublic=await member.ok<{items:{correctAnswer:number|null}[]}>("GET","/questions");
  assert(ownPublic.items.every(item=>item.correctAnswer===null));
  assert.equal((await member.request("POST","/questions",{
    question:"غير مصرح",options:["1","2"],correctAnswer:1,
  })).status,403);
  assert.equal((await member.request("GET",base+"/questions")).status,403);

  // A question is locked visually after submission and its saved answer persists
  // on page reload. No private answer statistics are exposed before answering.
  const beforeMember=await member.ok<{items:{
    id:number;correctAnswer:number|null;otherOptionCounts:number[]|null;
    myLastSelectedAnswer:number|null;myLastCorrect:boolean|null
  }[]}>("GET","/questions");
  const targetBefore=beforeMember.items.find(item=>item.id===publicQuestion);
  assert.equal(targetBefore?.correctAnswer,null);
  assert.equal(targetBefore?.otherOptionCounts,null);
  assert.equal(targetBefore?.myLastSelectedAnswer,null);

  const memberFirst=await member.ok<{
    selectedAnswer:number;correct:boolean;correctAnswer:number;
    otherOptionCounts:number[];points:number
  }>("POST",`/questions/${publicQuestion}/answers`,{
    selectedAnswer:3,idempotencyKey:randomUUID(),comment:"أول مشاركة",
  },201);
  assert.equal(memberFirst.correct,false);
  assert.equal(memberFirst.correctAnswer,1);
  assert.equal(memberFirst.selectedAnswer,3);
  assert.deepEqual(memberFirst.otherOptionCounts,[0,0,0]);

  const afterMember=await member.ok<{items:{
    id:number;correctAnswer:number|null;otherOptionCounts:number[]|null;
    myLastSelectedAnswer:number|null;myLastCorrect:boolean|null;
    myLastComment:string|null
  }[]}>("GET","/questions");
  const targetAfter=afterMember.items.find(item=>item.id===publicQuestion);
  assert.equal(targetAfter?.correctAnswer,1);
  assert.equal(targetAfter?.myLastSelectedAnswer,3);
  assert.equal(targetAfter?.myLastCorrect,false);
  assert.equal(targetAfter?.myLastComment,"أول مشاركة");
  assert.deepEqual(targetAfter?.otherOptionCounts,[0,0,0]);

  const memberTwo=new Client(owner.base);
  await memberTwo.ok("POST","/auth/register",{
    name:"Second member",displayName:"Second member",
    email:"member2@questions.test",phone:"",password,
  },201);
  await memberTwo.ok("POST",`/questions/${publicQuestion}/answers`,{
    selectedAnswer:2,idempotencyKey:randomUUID(),
  },201);
  const ownerResponse=await owner.ok<{
    selectedAnswer:number;correct:boolean;correctAnswer:number;otherOptionCounts:number[]
  }>("POST",`/questions/${publicQuestion}/answers`,{
    selectedAnswer:1,idempotencyKey:randomUUID(),
  },201);
  assert.equal(ownerResponse.correct,true);
  assert.deepEqual(ownerResponse.otherOptionCounts,[0,1,1]);
  const ownerCurrent=await owner.ok<{items:{id:number;otherOptionCounts:number[]|null}[]}>("GET","/questions");
  assert.deepEqual(ownerCurrent.items.find(q=>q.id===publicQuestion)?.otherOptionCounts,[0,1,1]);

  // Re-answering by the second member changes their one counted choice;
  // neither their old answer nor the requesting owner's own answer counts.
  await memberTwo.ok("POST",`/questions/${publicQuestion}/answers`,{
    selectedAnswer:3,idempotencyKey:randomUUID(),
  },201);
  const updated=await owner.ok<{items:{id:number;otherOptionCounts:number[]|null}[]}>("GET","/questions");
  assert.deepEqual(updated.items.find(q=>q.id===publicQuestion)?.otherOptionCounts,[0,0,2]);
  const otherSees=await member.ok<{items:{id:number;otherOptionCounts:number[]|null}[]}>("GET","/questions");
  assert.deepEqual(otherSees.items.find(q=>q.id===publicQuestion)?.otherOptionCounts,[1,0,1]);

  // Editing must save a question without dropping its existing answer history.
  const editable=(await owner.ok<{items:{id:number;revision:number}[]}>("GET","/questions?category=عام")).items
    .find(item=>item.id===publicQuestion);
  assert(editable);
  const edited=await owner.ok<{id:number;revision:number}>("PUT",`/questions/${publicQuestion}`,{
    category:"عام",priority:1,question:"سؤال من ثلاثة — تم تصحيحه",options:["1","2","3"],
    correctAnswer:1,points:1,active:true,revision:editable.revision
  });
  assert.equal(edited.revision,editable.revision+1);
  assert.equal((await owner.ok<{items:{question:string}[]}>("GET","/questions?category=عام")).items[0]?.question,
    "سؤال من ثلاثة — تم تصحيحه");

  // Archive/restore use only active and revision; answers and points survive.
  assert.equal((await member.request("PATCH",`/questions/${publicQuestion}/status`,
    {active:false,revision:edited.revision})).status,403);
  assert.equal((await owner.request("PATCH",`/questions/${publicQuestion}/status`,
    {active:false,revision:edited.revision-1})).status,409);
  const archived=await owner.ok<{revision:number;active:boolean}>("PATCH",
    `/questions/${publicQuestion}/status`,{active:false,revision:edited.revision});
  assert.equal(archived.active,false);
  assert.equal((await owner.ok<{total:number}>("GET","/questions?category=عام&status=active")).total,0);
  const archiveList=await owner.ok<{items:{id:number;active:boolean}[];total:number}>("GET",
    "/questions?category=عام&status=archived");
  assert.equal(archiveList.total,1);
  assert.equal(archiveList.items[0]?.active,false);
  assert.equal((await member.ok<{total:number}>("GET","/questions?category=عام&status=archived")).total,0);
  assert.equal((await owner.ok<{total:number}>("GET","/answers?questionId="+publicQuestion)).total,4);
  assert.equal((await member.request("POST",`/questions/${publicQuestion}/answers`,
    {selectedAnswer:1,idempotencyKey:randomUUID()})).status,404);
  const restored=await owner.ok<{active:boolean}>("PATCH",`/questions/${publicQuestion}/status`,
    {active:true,revision:archived.revision});
  assert.equal(restored.active,true);
  assert.equal((await member.ok<{total:number}>("GET","/questions?category=عام")).total,1);
});
