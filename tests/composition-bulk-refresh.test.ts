import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";

// Exercise the real 105 -> 116 projection upgrade in an isolated local schema.
// No environment DATABASE_URL, production connections, timing thresholds or
// disabled triggers are used by this regression.
test("bulk daily facts refresh each affected composition scope once and preserve insert/update/delete projections", async (t) => {
  const schema = `composition_bulk_${randomUUID().replaceAll("-", "")}`;
  const bootstrap = new Pool({ connectionString: DEFAULT_DATABASE_URL });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: DEFAULT_DATABASE_URL,
    options: `-c search_path=${schema}`,
    max: 1,
  });
  t.after(async () => {
    await pool.end();
    await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    await bootstrap.end();
  });
  await pool.query(`
    CREATE TABLE item_compositions(company_id integer,id integer,price_split_threshold numeric,PRIMARY KEY(company_id,id));
    CREATE TABLE items(company_id integer,id integer,name text,composition_id integer,sale_price1 numeric,purchase_price numeric,factor2 integer,factor3 integer,PRIMARY KEY(company_id,id));
    CREATE TABLE item_statistics(company_id integer,item_id integer,stock_total numeric,PRIMARY KEY(company_id,item_id));
    CREATE TABLE item_daily_activity(company_id integer,item_id integer,document_date date,
      sale_invoices integer DEFAULT 0,sale_return_invoices integer DEFAULT 0,
      sale_quantity numeric DEFAULT 0,sale_return_quantity numeric DEFAULT 0,
      purchase_invoices integer DEFAULT 0,purchase_return_invoices integer DEFAULT 0,
      purchase_quantity numeric DEFAULT 0,purchase_return_quantity numeric DEFAULT 0,
      updated_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(company_id,item_id,document_date));
    CREATE TABLE item_sale_rankings(company_id integer,item_id integer);
    INSERT INTO item_compositions VALUES(1,1,NULL),(1,2,50),(2,1,NULL);
    INSERT INTO items VALUES(1,1,'One',1,10,5,1,1),(1,2,'Two',1,20,8,2,1),
      (1,3,'Three',2,100,30,1,1),(1,4,'Unlinked',NULL,10,5,1,1),
      (2,1,'Other company',1,10,5,1,1);
    INSERT INTO item_statistics SELECT company_id,id,1 FROM items;
  `);
  const migration = async (name: string) =>
    pool.query(
      await readFile(
        new URL(`../apps/api/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await migration("105_composition_statistics.sql");
  await migration("117_composition_daily_statement_refresh.sql");
  await pool.query(
    "CREATE TABLE refresh_calls(kind text,company_id integer,composition_id integer,document_date date)",
  );
  // Instrument the actual functions without replacing their calculations. Counts
  // verify bounded refresh work independently of machine speed.
  for (const [name, kind] of [
    ["refresh_composition_daily_date(integer,integer,date)", "daily"],
    ["refresh_composition_summary(integer,integer)", "summary"],
  ] as const) {
    const definition = (
      await pool.query(
        "SELECT pg_get_functiondef($1::regprocedure) AS definition",
        [name],
      )
    ).rows[0].definition as string;
    await pool.query(
      definition.replace(
        /BEGIN/,
        `BEGIN\n INSERT INTO refresh_calls VALUES('${kind}',p_company,p_composition,${kind === "daily" ? "p_date" : "NULL"});`,
      ),
    );
  }
  const day = (
    await pool.query(
      "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS day",
    )
  ).rows[0].day;
  const calls = async () =>
    (
      await pool.query(
        "SELECT kind,count(*)::integer AS n FROM refresh_calls GROUP BY kind ORDER BY kind",
      )
    ).rows;
  const clear = () => pool.query("TRUNCATE refresh_calls");
  const snapshot = async () => ({
    daily: (
      await pool.query(
        "SELECT to_jsonb(d)-'updated_at' AS row FROM item_composition_daily_statistics d ORDER BY company_id,composition_id,group_key,document_date",
      )
    ).rows,
    summary: (
      await pool.query(
        "SELECT to_jsonb(s)-'updated_at' AS row FROM item_composition_statistics s ORDER BY company_id,composition_id,group_key",
      )
    ).rows,
  });
  const verifyRebuild = async () => {
    const current = await snapshot();
    await pool.query(
      "SELECT rebuild_composition_daily(company_id,id),refresh_composition_summary(company_id,id) FROM item_compositions ORDER BY company_id,id",
    );
    assert.deepEqual(
      await snapshot(),
      current,
      "incremental projections match a full canonical rebuild",
    );
    await clear();
  };
  await pool.query(
    `INSERT INTO item_daily_activity(company_id,item_id,document_date,sale_invoices,sale_quantity)
    VALUES(1,1,$1,1,10),(1,2,$1,2,20),(1,1,$1::date+1,3,30),
      (1,3,$1,4,40),(1,4,$1,5,50),(2,1,$1,6,60)`,
    [day],
  );
  assert.deepEqual(await calls(), [
    { kind: "daily", n: 4 },
    { kind: "summary", n: 3 },
  ]);
  assert.equal(
    (
      await pool.query(
        "SELECT sale_times::text AS n FROM item_composition_daily_statistics WHERE company_id=1 AND composition_id=1 AND document_date=$1",
        [day],
      )
    ).rows[0].n,
    "3",
  );
  await verifyRebuild();

  // Both old and new dates matter when a bulk update changes the primary key.
  await pool.query(
    "UPDATE item_daily_activity SET document_date=document_date+2,sale_invoices=sale_invoices+1 WHERE company_id=1 AND item_id IN(1,2) AND document_date=$1",
    [day],
  );
  assert.deepEqual(await calls(), [
    { kind: "daily", n: 2 },
    { kind: "summary", n: 1 },
  ]);
  await verifyRebuild();
  await pool.query(
    "UPDATE item_daily_activity SET updated_at=clock_timestamp()",
  );
  assert.deepEqual(
    await calls(),
    [],
    "timestamps alone do not rebuild composition statistics",
  );

  // ON CONFLICT can run both statement triggers; empty transition sets must not
  // cause a second refresh of the updated row.
  await pool.query(
    `INSERT INTO item_daily_activity(company_id,item_id,document_date,sale_invoices,sale_quantity)
    VALUES(1,3,$1,7,70) ON CONFLICT(company_id,item_id,document_date)
    DO UPDATE SET sale_invoices=EXCLUDED.sale_invoices,sale_quantity=EXCLUDED.sale_quantity`,
    [day],
  );
  assert.deepEqual(await calls(), [
    { kind: "daily", n: 1 },
    { kind: "summary", n: 1 },
  ]);
  await verifyRebuild();
  const beforeRollback = await snapshot();
  await pool.query("BEGIN");
  await pool.query(
    "DELETE FROM item_daily_activity WHERE company_id=1 AND item_id IN(1,2,3)",
  );
  assert.deepEqual(await calls(), [
    { kind: "daily", n: 3 },
    { kind: "summary", n: 2 },
  ]);
  await pool.query("ROLLBACK");
  assert.deepEqual(
    await snapshot(),
    beforeRollback,
    "facts and projections roll back together",
  );
  assert.deepEqual(await calls(), []);
  await pool.query(
    "DELETE FROM item_daily_activity WHERE company_id=1 AND item_id IN(1,2,3)",
  );
  assert.deepEqual(await calls(), [
    { kind: "daily", n: 3 },
    { kind: "summary", n: 2 },
  ]);
  await verifyRebuild();
  assert.equal(
    (
      await pool.query(
        "SELECT sale_times::text AS n FROM item_composition_daily_statistics WHERE company_id=2",
      )
    ).rows[0].n,
    "6",
    "other company projections remain unchanged",
  );
});
