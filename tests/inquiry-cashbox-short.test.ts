import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { inquiryRoutes, shortenCashboxQuestion, shortenCashboxQuestionSchema } from "../apps/api/src/routes-inquiries.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";

test("cashbox shortening contract is company scoped and does not accept replacement text",()=>{
  const router=inquiryRoutes({} as Pool);
  const operation="PATCH /companies/:companyId/inquiries/:inquiryId/shorten-cashbox-question";
  const result=apiCatalog(router,{operation});
  assert.equal(result.operations[0]?.operation,operation);
  assert.match(JSON.stringify(result),/"expectedUpdatedAt"/);
  assert.doesNotMatch(JSON.stringify(result),/"requestText"/);
  assert(!shortenCashboxQuestionSchema.safeParse({requestText:"change anything",expectedUpdatedAt:"2026-11-20T00:00:00Z"}).success);
  assert(!apiCatalog(router,{operation:"PATCH /inquiries/:inquiryId/shorten-cashbox-question"}).operations.length);
});

test("shortens only verified legacy cashbox text, preserving dates, amounts, status, recipients and answers",async(t)=>{
  const pg=new PGlite();
  t.after(()=>pg.close());
  await pg.exec(`
    CREATE TABLE inquiry_requests(id int PRIMARY KEY,company_id int,request_text text,task_name text,updated_by int,
      updated_at timestamptz NOT NULL,status text,linked_table text,linked_record_id bigint);
    CREATE TABLE inquiry_targets(inquiry_id int,user_id int);
    CREATE TABLE inquiry_answers(inquiry_id int,user_id int,answer text);
    CREATE TABLE audit_events(actor_id int,actor_name text,scope text,company_id int,action text,
      target_type text,target_id int,before_value jsonb,after_value jsonb);
  `);
  const db={query:(sql:string,params?:unknown[])=>pg.query(sql,params)} as unknown as PoolClient;
  const latest="2026-11-20T00:00:00Z";
  const owner={id:1,displayName:"Owner"} as User;
  const examples=[
    ["2026-11-19","عجز","3,098"],["2026-11-19","عجز","15,250"],["2026-11-20","زيادة","2,900"],
    ["2026-11-19","زيادة","1,100"],["2026-11-20","زيادة","4,352"],["2026-11-20","زيادة","1,201"],
    ["2026-11-19","زيادة","2,250"],
  ];
  for(const [i,[date,kind,amount]] of examples.entries()){
    const id=61+i;
    const tail=`${date}، ظهر في صندوقك صافي ${kind} قدره ${amount} ريال. هل توضح السبب أو تذكر أي فاتورة أو تسوية مرتبطة بالفرق؟`;
    const long="السلام عليكم، بعد احتساب المدين والدائن في حساب عجز وزيادة الصناديق (5499999000) لتاريخ "+tail;
    await db.query(`INSERT INTO inquiry_requests VALUES($1,2,$2,'اسم المهمة',4,$3,'closed','مهام الذكاء الاصطناعي',434)`,[id,long,latest]);
    await db.query("INSERT INTO inquiry_targets VALUES($1,19)",[id]);
    await db.query("INSERT INTO inquiry_answers VALUES($1,19,'unchanged')",[id]);
    const old=(await db.query("SELECT * FROM inquiry_requests WHERE id=$1",[id])).rows[0];
    await assert.rejects(shortenCashboxQuestion(db,owner,2,id,old,{expectedUpdatedAt:"2026-11-19T00:00:00Z"}),{status:409});
    await assert.rejects(shortenCashboxQuestion(db,owner,3,id,old,{expectedUpdatedAt:latest}),{status:404});
    await assert.rejects(shortenCashboxQuestion(db,owner,2,id,{...old,linked_record_id:435},{expectedUpdatedAt:latest}),{status:404});
    await assert.rejects(shortenCashboxQuestion(db,owner,2,id,{...old,request_text:long+" تخصيص"},{expectedUpdatedAt:latest}),{status:409});
    const applied=await shortenCashboxQuestion(db,owner,2,id,old,{expectedUpdatedAt:latest});
    assert.equal(applied.requestText,"تاريخ "+tail);
    const current=(await db.query("SELECT * FROM inquiry_requests WHERE id=$1",[id])).rows[0];
    assert.equal(current.request_text,applied.requestText);
    assert.notEqual(current.updated_at.toISOString(),old.updated_at.toISOString());
    for(const field of Object.keys(old).filter(x=>x!=="updated_at" && x!=="request_text")) assert.deepEqual(current[field],old[field]);
    assert.deepEqual((await db.query("SELECT * FROM inquiry_targets WHERE inquiry_id=$1",[id])).rows,[{inquiry_id:id,user_id:19}]);
    assert.deepEqual((await db.query("SELECT * FROM inquiry_answers WHERE inquiry_id=$1",[id])).rows,[{inquiry_id:id,user_id:19,answer:"unchanged"}]);
    assert.deepEqual(await shortenCashboxQuestion(db,owner,2,id,current,{expectedUpdatedAt:applied.updatedAt}),applied);
  }
  assert.equal((await db.query("SELECT * FROM audit_events WHERE action='inquiry.shortenCashboxQuestion'")).rows.length,7);
});
