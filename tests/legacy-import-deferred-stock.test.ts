import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";

// Exercise the actual reconciliation migration on a disposable local schema.
// The small source tables isolate reconciliation from unrelated projections;
// the trusted-run helper implements migration 130's company/context contract.
async function fixture(t: TestContext) {
  const schema = `legacy_stock_${randomUUID().replaceAll("-", "")}`;
  const bootstrap = new Pool({ connectionString: DEFAULT_DATABASE_URL });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: DEFAULT_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  t.after(async () => {
    await pool.end();
    await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    await bootstrap.end();
  });
  await pool.query(`
    CREATE TABLE legacy_import_runs (
      company_id integer NOT NULL,idempotency_key uuid NOT NULL,status text NOT NULL,
      PRIMARY KEY(company_id,idempotency_key)
    );
    CREATE TABLE legacy_import_dirty_items (
      company_id integer NOT NULL,item_id integer NOT NULL,
      PRIMARY KEY(company_id,item_id)
    );
    CREATE FUNCTION legacy_import_is_deferred(p_company integer)
      RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM legacy_import_runs
        WHERE company_id=p_company AND status='running'
        AND idempotency_key::text=current_setting('alraesy.legacy_import_run',true))
      $$;
    CREATE TABLE stock_item_valuations (
      company_id integer NOT NULL,item_id integer NOT NULL,
      quantity_smallest numeric(40,0) NOT NULL,value_base numeric(32,6) NOT NULL,
      PRIMARY KEY(company_id,item_id)
    );
    CREATE TABLE stock_balances (
      company_id integer NOT NULL,item_id integer NOT NULL,
      location_id integer NOT NULL,batch_key text NOT NULL DEFAULT '',
      quantity_smallest numeric(40,0) NOT NULL,
      PRIMARY KEY(company_id,item_id,location_id,batch_key)
    );
    CREATE TABLE stock_movements (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id integer NOT NULL,item_id integer NOT NULL,
      location_id integer NOT NULL,batch_key text NOT NULL DEFAULT '',
      quantity_smallest numeric(40,0) NOT NULL,cost_base numeric(32,6) NOT NULL
    );
  `);
  await pool.query(await readFile(new URL(
    "../apps/api/migrations/132_legacy_import_deferred_stock_checks.sql", import.meta.url,
  ), "utf8"));
  await pool.query(`
    CREATE CONSTRAINT TRIGGER stock_balances_integrity
      AFTER INSERT OR UPDATE OR DELETE ON stock_balances
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stock_integrity();
    CREATE CONSTRAINT TRIGGER stock_valuations_integrity
      AFTER INSERT OR UPDATE OR DELETE ON stock_item_valuations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stock_integrity();
    CREATE CONSTRAINT TRIGGER stock_movements_integrity
      AFTER INSERT ON stock_movements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stock_integrity();
  `);
  return pool;
}

async function seed(client: PoolClient, companyId = 1, itemId = 1,
  quantity = "10", value = "50") {
  await client.query(
    "INSERT INTO stock_item_valuations VALUES($1,$2,$3,$4)",
    [companyId,itemId,quantity,value],
  );
  await client.query(
    "INSERT INTO stock_balances VALUES($1,$2,1,'',$3)",
    [companyId,itemId,quantity],
  );
  await client.query(
    "INSERT INTO stock_movements(company_id,item_id,location_id,quantity_smallest,cost_base) VALUES($1,$2,1,$3,$4)",
    [companyId,itemId,quantity,value],
  );
}

test("ordinary stock posting rejects inconsistent quantities and costs", async (t) => {
  const pool = await fixture(t);
  for (const change of [
    "UPDATE stock_balances SET quantity_smallest=11",
    "UPDATE stock_item_valuations SET value_base=51",
  ]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await seed(client);
      await client.query(change);
      await assert.rejects(client.query("SET CONSTRAINTS ALL IMMEDIATE"), {code:"23514"});
      await client.query("ROLLBACK");
    } finally { client.release(); }
  }
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM stock_balances")).rows[0].n,0);
});

test("trusted bulk context queues each item and final reconciliation still rejects corruption", async (t) => {
  const pool = await fixture(t);
  const runId = randomUUID();
  await pool.query("INSERT INTO legacy_import_runs VALUES(1,$1,'running')",[runId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('alraesy.legacy_import_run',$1,true)",[runId]);
    await seed(client);
    await client.query("UPDATE stock_balances SET quantity_smallest=12");
    await client.query("UPDATE stock_item_valuations SET quantity_smallest=12");
    // A full reconciliation here would fail: the final two units are not in
    // history yet. All deferred row events only enqueue the same dirty item.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    assert.deepEqual((await client.query("SELECT * FROM legacy_import_dirty_items")).rows,
      [{company_id:1,item_id:1}]);
    await client.query("COMMIT");
    await assert.rejects(pool.query("SELECT assert_stock_integrity(1,1)"), {code:"23514"});

    await client.query("BEGIN");
    await client.query("SELECT set_config('alraesy.legacy_import_run',$1,true)",[runId]);
    await client.query("INSERT INTO stock_movements(company_id,item_id,location_id,quantity_smallest,cost_base) VALUES(1,1,1,2,0)");
    await client.query("COMMIT");
    await pool.query("SELECT assert_stock_integrity(1,1)");
    // The transaction-local bypass does not survive COMMIT.
    await client.query("BEGIN");
    await client.query("UPDATE stock_balances SET quantity_smallest=13");
    await assert.rejects(client.query("COMMIT"), {code:"23514"});
    await client.query("ROLLBACK");
  } finally { client.release(); }
});

test("bulk deferral is scoped to an active run and its company", async (t) => {
  const pool = await fixture(t);
  const runId = randomUUID();
  await pool.query("INSERT INTO legacy_import_runs VALUES(1,$1,'running')",[runId]);
  for (const [companyId,context] of [[2,runId],[1,randomUUID()]] as const) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('alraesy.legacy_import_run',$1,true)",[context]);
      await seed(client,companyId);
      await client.query("UPDATE stock_balances SET quantity_smallest=11");
      await assert.rejects(client.query("SET CONSTRAINTS ALL IMMEDIATE"), {code:"23514"});
      await client.query("ROLLBACK");
    } finally { client.release(); }
  }
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM legacy_import_dirty_items")).rows[0].n,0);
});

test("savepoint rollback removes the dirty item together with failed source writes", async (t) => {
  const pool = await fixture(t);
  const runId = randomUUID();
  await pool.query("INSERT INTO legacy_import_runs VALUES(1,$1,'running')",[runId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('alraesy.legacy_import_run',$1,true)",[runId]);
    await client.query("SAVEPOINT document");
    await seed(client);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    assert.equal((await client.query("SELECT count(*)::integer AS n FROM legacy_import_dirty_items")).rows[0].n,1);
    await client.query("ROLLBACK TO SAVEPOINT document");
    assert.equal((await client.query("SELECT count(*)::integer AS n FROM legacy_import_dirty_items")).rows[0].n,0);
    assert.equal((await client.query("SELECT count(*)::integer AS n FROM stock_movements")).rows[0].n,0);
    await client.query("ROLLBACK");
  } finally { client.release(); }
});

test("final reconciliation checks per-batch quantities and zero-net orphan history", async (t) => {
  const pool = await fixture(t);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await seed(client);
    await client.query("UPDATE stock_balances SET quantity_smallest=9");
    await client.query("INSERT INTO stock_balances VALUES(1,1,2,'',1)");
    await assert.rejects(client.query("SELECT assert_stock_integrity(1,1)"), {code:"23514"});
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("INSERT INTO stock_item_valuations VALUES(1,1,0,0)");
    await client.query("INSERT INTO stock_movements(company_id,item_id,location_id,quantity_smallest,cost_base) VALUES(1,1,1,5,25),(1,1,1,-5,-25)");
    await assert.rejects(client.query("SELECT assert_stock_integrity(1,1)"), {code:"23514"});
    await client.query("ROLLBACK");
    await assert.rejects(client.query("SELECT assert_stock_integrity(1,999)"), {code:"23514"});
  } finally { client.release(); }
});

test("final reconciliation retains exact large quantities and signed negative stock", async (t) => {
  const pool = await fixture(t);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await seed(client,1,1,"9007199254740993","900719925474099.93");
    await seed(client,1,2,"-4","-12");
    await client.query("SELECT assert_stock_integrity(1,1),assert_stock_integrity(1,2)");
    await client.query("COMMIT");
  } finally { client.release(); }
});
