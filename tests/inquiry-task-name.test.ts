import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { editInquiryTaskName, inquiryRoutes, inquiryTaskNameSchema, linkedCompanyInquiryTaskName } from "../apps/api/src/routes-inquiries.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";

test("inquiry create and edit contracts expose task name on both surfaces",()=>{
  const router=inquiryRoutes({} as Pool);
  for(const root of ["/inquiries","/companies/:companyId/inquiries"]){
    assert.match(JSON.stringify(apiCatalog(router,{operation:"POST "+root})),/"taskName"/);
    const edit=apiCatalog(router,{operation:`PATCH ${root}/:inquiryId/task-name`});
    assert.match(JSON.stringify(edit),/"taskName"/);
    assert.match(JSON.stringify(edit),/"expectedUpdatedAt"/);
  }
  assert(!inquiryTaskNameSchema.safeParse({taskName:"   ",expectedUpdatedAt:"2026-11-20T00:00:00Z"}).success);
});

test("linked company task title is isolated and an existing inquiry keeps content, assignment and state",async(t)=>{
  const pg=new PGlite();
  t.after(()=>pg.close());
  await pg.exec(`
    CREATE TABLE ai_tasks(task_id int PRIMARY KEY,company_id int,section text,private_title text,private_description text,archived_at timestamptz);
    CREATE TABLE general_table(general_table_id int PRIMARY KEY,general_table_title text,general_table_table_name text,general_table_category text);
    INSERT INTO ai_tasks VALUES (434,2,'الشركة',NULL,NULL,NULL),(435,2,'مهمة خاصة بمصطفى','خاص','خاص',NULL);
    INSERT INTO general_table VALUES
      (434,'متابعة العجز والزيادة في الصناديق','مهام الذكاء الاصطناعي','الشركة'),
      (435,'معرف','معرفات المهام الشخصية','');
    CREATE TABLE inquiry_requests(id int PRIMARY KEY,company_id int,request_text text,task_name text,updated_by int,
      updated_at timestamptz NOT NULL,status text,linked_table text,linked_record_id int);
    CREATE TABLE inquiry_targets(inquiry_id int,user_id int);
    INSERT INTO inquiry_requests VALUES (61,2,'keep content','',NULL,'2026-11-20T00:00:00Z','closed','مهام الذكاء الاصطناعي',434);
    INSERT INTO inquiry_targets VALUES (61,19);
    CREATE TABLE audit_events(actor_id int,actor_name text,scope text,company_id int,action text,
      target_type text,target_id int,before_value jsonb,after_value jsonb);
  `);
  const db={query:(sql:string,params?:unknown[])=>pg.query(sql,params)} as unknown as PoolClient;
  const name="متابعة العجز والزيادة في الصناديق";
  assert.equal(await linkedCompanyInquiryTaskName(db,2,"مهام الذكاء الاصطناعي",434),name);
  assert.equal(await linkedCompanyInquiryTaskName(db,2,"invoices",434),"");
  assert.equal(await linkedCompanyInquiryTaskName(db,null,"ai_tasks",434),"");
  await assert.rejects(linkedCompanyInquiryTaskName(db,9,"ai_tasks",434),{status:404});
  await assert.rejects(linkedCompanyInquiryTaskName(db,2,"ai_tasks",435),{status:404});
  const viewer={id:1,displayName:"Owner"} as User;
  const old=(await db.query("SELECT * FROM inquiry_requests WHERE id=61")).rows[0];
  await assert.rejects(editInquiryTaskName(db,viewer,2,61,old,{taskName:name,expectedUpdatedAt:"2026-11-19T00:00:00Z"}),{status:409});
  const applied=await editInquiryTaskName(db,viewer,2,61,old,{taskName:name,expectedUpdatedAt:"2026-11-20T03:00:00+03:00"});
  const current=(await db.query("SELECT * FROM inquiry_requests WHERE id=61")).rows[0];
  assert.equal(current.task_name,name);
  for(const key of ["request_text","status","linked_table","linked_record_id","company_id"])assert.equal(current[key],old[key]);
  assert.deepEqual((await db.query("SELECT * FROM inquiry_targets")).rows,[{inquiry_id:61,user_id:19}]);
  assert.equal((await editInquiryTaskName(db,viewer,2,61,current,{taskName:name,expectedUpdatedAt:applied.updatedAt})).updatedAt,applied.updatedAt);
  assert.deepEqual((await db.query("SELECT action,target_id FROM audit_events")).rows,[{action:"inquiry.taskName",target_id:61}]);
});
