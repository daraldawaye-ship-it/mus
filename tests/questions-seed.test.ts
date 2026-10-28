import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";

// Disposable test schema. No production data or production credentials.
test("20 children's questions: public scope, correct options, one point, no duplicates", async t => {
  const schema="kids_questions_"+randomUUID().replaceAll("-","");
  const db=process.env.DATABASE_URL??DEFAULT_DATABASE_URL;
  const app=await createApp({ databaseUrl:db,schema,production:false,serveStatic:false });
  t.after(async()=>{
    await app.close();
    const pool=new Pool({connectionString:db});
    try {await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}
    finally {await pool.end();}
  });
  await provisionOwner(app.pool,{
    name:"Test owner",displayName:"Test owner",email:"kids-questions-owner@test.invalid",
    password:"Questions-test-password-2026",
  });
  const sql=await readFile(fileURLToPath(
    new URL("../apps/api/migrations/148_seed_children_questions.sql",import.meta.url)
  ),"utf8");
  await app.pool.query(sql);
  const result=await app.pool.query(
    "SELECT category,question,answer1,answer2,answer3,answer4,option_count,correct_answer,points,active,company_id FROM questions WHERE company_id IS NULL AND category=$1",
    ["أسئلة للأطفال"],
  );
  assert.equal(result.rowCount,20);
  const questions=result.rows;
  assert.equal(new Set(questions.map(q=>q.question)).size,20);
  for(const question of questions){
    assert.equal(question.option_count,4);
    assert.equal(question.points,1);
    assert.equal(question.active,true);
    assert.equal(question.company_id,null);
    assert(question.correct_answer>=1&&question.correct_answer<=4);
    assert([question.answer1,question.answer2,question.answer3,question.answer4].every(Boolean));
  }
  const q=(text:string)=>questions.find(item=>item.question===text);
  assert.equal(q("كم عدد سور القرآن الكريم؟")?.answer3,"114 سورة");
  assert.equal(q("كم عدد سور القرآن الكريم؟")?.correct_answer,3);
  assert.equal(q("كم عدد كواكب المجموعة الشمسية؟")?.answer1,"8 كواكب");
  assert.equal(q("من هو النبي الذي كانت معجزته الناقة؟")?.answer2,"صالح عليه السلام");
  await app.pool.query(sql);
  const again=await app.pool.query("SELECT count(*)::int AS total FROM questions WHERE company_id IS NULL AND category=$1",["أسئلة للأطفال"]);
  assert.equal(again.rows[0].total,20);
  const audits=await app.pool.query(
    "SELECT count(*)::int AS total FROM audit_events WHERE scope='public' AND action='question.create' AND target_type='question'"
  );
  assert.equal(audits.rows[0].total,20);
});