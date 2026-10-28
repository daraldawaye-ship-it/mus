import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";

test("228 public pharmacy questions are attributed to the verified Waleed account; rerun is idempotent", async t => {
  const schema="pharmacy_import_"+randomUUID().replaceAll("-","");
  const databaseUrl=process.env.DATABASE_URL??DEFAULT_DATABASE_URL;
  const runtime=await createApp({databaseUrl,schema,serveStatic:false,production:false});
  t.after(async()=>{
    await runtime.close();
    const pool=new Pool({connectionString:databaseUrl});
    try {await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}
    finally {await pool.end();}
  });
  await provisionOwner(runtime.pool,{
    name:"Owner",displayName:"Owner",email:"owner-pharmacy-test@example.invalid",
    password:"Pharmacy-test-password-2026",
  });
  const sql=await readFile(fileURLToPath(
    new URL("../apps/api/migrations/149_import_pharmacy_questions.sql",import.meta.url)
  ),"utf8");
  await runtime.pool.query(sql);
  const empty=await runtime.pool.query(
    "SELECT count(*)::int AS total FROM questions WHERE category='معلومات صيدلانية'");
  assert.equal(empty.rows[0].total,0,"Never assign questions to the wrong account");

  await runtime.pool.query(`
    INSERT INTO users(id,name,display_name,email,password_hash,kind)
    VALUES (19,'Dr. Waleed Al-Sibakhi','Dr. Waleed Al-Sibakhi',
    'waleed-pharmacy-test@example.invalid','unused-test-only','member')`);
  await runtime.pool.query(sql);
  const result=await runtime.pool.query(`
    SELECT id,created_by,category,option_count,correct_answer,points,active,
      answer1,answer2,answer3,answer4,question
    FROM questions WHERE company_id IS NULL AND category='معلومات صيدلانية'`);
  assert.equal(result.rowCount,228);
  assert.equal(new Set(result.rows.map(q=>q.question)).size,228);
  assert.equal(result.rows.filter(q=>q.option_count===2).length,22);
  assert.equal(result.rows.filter(q=>q.option_count===4).length,206);
  for(const q of result.rows) {
    assert.equal(q.created_by,19);
    assert.equal(q.active,true);
    assert(q.correct_answer>=1 && q.correct_answer<=q.option_count);
    assert.equal(q.points,1);
    assert(q.answer1&&q.answer2);
    assert.equal(Boolean(q.answer3),q.option_count>2);
    assert.equal(Boolean(q.answer4),q.option_count>3);
  }
  const audits=await runtime.pool.query(`
    SELECT count(*)::int AS total, count(DISTINCT after_value->>'sourceUrl')::int AS sources,
      count(*) FILTER(WHERE actor_id IS NULL AND after_value->>'createdBy'='19')::int AS correctly_attributed
    FROM audit_events WHERE action='question.create' AND target_type='question'
      AND after_value->>'category'='معلومات صيدلانية'`);
  assert.equal(audits.rows[0].total,228);
  assert.equal(audits.rows[0].sources,228);
  assert.equal(audits.rows[0].correctly_attributed,228);
  await runtime.pool.query(sql);
  const again=await runtime.pool.query(
    "SELECT count(*)::int AS total FROM questions WHERE category='معلومات صيدلانية'");
  assert.equal(again.rows[0].total,228);
});