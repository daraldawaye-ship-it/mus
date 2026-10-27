import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createDatabase } from "../apps/api/src/db.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";

// This test must never use an inherited production DATABASE_URL.
async function fixture(t: TestContext) {
  const schema = `database_pause_${randomUUID().replaceAll("-", "")}`;
  const pool = await createDatabase(DEFAULT_DATABASE_URL, schema);
  t.after(async () => {
    await pool.end();
    const cleanup = new Pool({ connectionString: DEFAULT_DATABASE_URL });
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });
  return pool;
}

test("database pause disables calculation triggers and preserves all integrity guards", async t => {
  const pool = await fixture(t);
  assert.equal((await pool.query("SELECT paused FROM automation_database_pause WHERE singleton")).rows[0].paused, true);
  const saved = await pool.query(`SELECT count(*)::integer AS total,
    count(*) FILTER(WHERE t.oid IS NULL OR t.tgenabled::text<>'D')::integer AS active
    FROM automation_paused_triggers s
    LEFT JOIN pg_namespace n ON n.nspname=s.schema_name
    LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=s.table_name
    LEFT JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname=s.trigger_name`);
  assert.equal(saved.rows[0].total, 28);
  assert.equal(saved.rows[0].active, 0);
  const guards = (await pool.query(`SELECT
    count(*)::integer AS total,
    count(*) FILTER(WHERE t.tgenabled::text='D')::integer AS disabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND
      (t.tgisinternal OR t.tgconstraint<>0 OR t.tgname ~ '(integrity|history|immutable)$')`)).rows[0];
  assert.ok(guards.total>50);
  assert.equal(guards.disabled, 0);
  const functions = (await pool.query(`SELECT count(*)::integer AS total,
    count(*) FILTER(WHERE position('DATABASE_AUTOMATION_PAUSED' IN pg_get_functiondef(p.oid))=0)::integer AS unguarded
    FROM automation_paused_functions s
    JOIN pg_namespace n ON n.nspname=s.schema_name
    JOIN pg_proc p ON p.pronamespace=n.oid AND p.proname=s.function_name
      AND pg_get_function_identity_arguments(p.oid)=s.identity_arguments`)).rows[0];
  assert.deepEqual(functions,{total:19,unguarded:0});
});

test("paused direct calculations perform no writes even inside a read-only transaction", async t => {
  const pool = await fixture(t), client = await pool.connect();
  const before = (await pool.query(`SELECT
    (SELECT count(*)::integer FROM item_sale_ranking_days) AS days,
    (SELECT count(*)::integer FROM item_statistics) AS items,
    (SELECT count(*)::integer FROM account_statistics) AS accounts`)).rows[0];
  try {
    await client.query("BEGIN READ ONLY");
    assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,"on");
    await client.query("SELECT prepare_item_sale_rankings('2099-01-01'::date)");
    await client.query("SELECT refresh_item_statistics(999999,999999)");
    await client.query("SELECT refresh_item_adjustment_counts(999999,999999)");
    await client.query("SELECT refresh_item_negative_stock(999999,999999)");
    await client.query("SELECT initialize_account_statistics(999999,999999)");
    const result = (await client.query(`SELECT
      refresh_account_balance_statistics(999999,999999,'2099-01-01'::date) AS balance,
      refresh_account_activity_statistics(999999,999999,'2099-01-01'::date) AS activity,
      refresh_account_stock_statistics(999999,999999) AS stock`)).rows[0];
    assert.deepEqual(result,{balance:false,activity:false,stock:false});
    await client.query("ROLLBACK");
  } finally { client.release(); }
  assert.deepEqual((await pool.query(`SELECT
    (SELECT count(*)::integer FROM item_sale_ranking_days) AS days,
    (SELECT count(*)::integer FROM item_statistics) AS items,
    (SELECT count(*)::integer FROM account_statistics) AS accounts`)).rows[0],before);
});

test("explicit restoration recovers exact saved definitions and trigger states and can be paused again", async t => {
  const pool = await fixture(t);
  const backups = (await pool.query(`SELECT
    (SELECT count(*)::integer FROM automation_paused_triggers) AS triggers,
    (SELECT count(*)::integer FROM automation_paused_functions) AS functions`)).rows[0];
  await pool.query("SELECT restore_database_automation()");
  assert.equal((await pool.query("SELECT paused FROM automation_database_pause WHERE singleton")).rows[0].paused,false);
  const changedTriggers = (await pool.query(`SELECT count(*)::integer AS n
    FROM automation_paused_triggers s JOIN pg_namespace n ON n.nspname=s.schema_name
    JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=s.table_name
    JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname=s.trigger_name
    WHERE t.tgenabled::text<>s.original_enabled`)).rows[0].n;
  assert.equal(changedTriggers,0);
  const changedFunctions = (await pool.query(`SELECT count(*)::integer AS n
    FROM automation_paused_functions s JOIN pg_namespace n ON n.nspname=s.schema_name
    JOIN pg_proc p ON p.pronamespace=n.oid AND p.proname=s.function_name
      AND pg_get_function_identity_arguments(p.oid)=s.identity_arguments
    WHERE pg_get_functiondef(p.oid)<>s.original_definition`)).rows[0].n;
  assert.equal(changedFunctions,0);
  await pool.query(await readFile(new URL("../apps/api/migrations/133_pause_database_automation.sql",import.meta.url),"utf8"));
  assert.equal((await pool.query("SELECT paused FROM automation_database_pause WHERE singleton")).rows[0].paused,true);
  assert.deepEqual((await pool.query(`SELECT
    (SELECT count(*)::integer FROM automation_paused_triggers) AS triggers,
    (SELECT count(*)::integer FROM automation_paused_functions) AS functions`)).rows[0],backups);
});
