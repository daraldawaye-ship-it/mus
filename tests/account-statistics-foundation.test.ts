import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { Pool, type QueryResultRow } from "pg";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { transaction } from "../apps/api/src/db.ts";

// Never inherit DATABASE_URL: these checks create and remove a disposable schema.
// CI may explicitly provide a local PostgreSQL service using this test-only key.
const databaseUrl =
  process.env.ACCOUNT_STATISTICS_TEST_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const target = new URL(databaseUrl);
const localHosts = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "/workspace/.tools/postgresql/socket",
]);
const configuredHosts = [
  target.hostname,
  ...target.searchParams.getAll("host"),
  ...target.searchParams.getAll("hostaddr"),
].filter(Boolean);
assert(
  ["postgres:", "postgresql:"].includes(target.protocol) &&
    configuredHosts.length > 0 &&
    configuredHosts.every((host) => localHosts.has(host)),
  "Account-statistics tests require an explicitly local PostgreSQL target",
);

const migrationDirectory = new URL("../apps/api/migrations/", import.meta.url);
const summaryFamilies = ["balance", "activity", "commerce", "stock"] as const;

// This suite verifies phase two at its actual schema boundary. Later migrations
// activate action guards and source hooks that intentionally change that scope.
async function migrateFoundation(pool: Pool) {
  const names = (await readdir(migrationDirectory))
    .filter(
      (name) =>
        /^\d+_[a-z_]+\.sql$/.test(name) && Number(name.split("_")[0]) <= 85,
    )
    .sort();
  await transaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext(current_schema()))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of names) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version=$1",
        [name],
      );
      if (applied.rowCount) continue;
      await client.query(
        await readFile(new URL(name, migrationDirectory), "utf8"),
      );
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        name,
      ]);
    }
  });
}

async function fixture(t: TestContext) {
  const schema = `account_stats_${randomUUID().replaceAll("-", "")}`;
  const setup = new Pool({ connectionString: databaseUrl, max: 1 });
  let scoped: Pool | undefined;
  t.after(async () => {
    await scoped?.end();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await setup.end();
    }
  });
  await setup.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 2,
  });
  scoped = pool;
  // Exercise an actual upgrade, without deleting migration receipts or dropping
  // current tables to impersonate an older schema.
  const legacyMigrations = (await readdir(migrationDirectory))
    .filter(
      (name) =>
        /^\d+_[a-z_]+\.sql$/.test(name) && Number(name.split("_")[0]) <= 84,
    )
    .sort();
  assert(legacyMigrations.includes("072_legacy_supplier_inference.sql"));
  assert(legacyMigrations.includes("074_attendance_control_snapshot.sql"));
  assert(legacyMigrations.includes("084_electronic_wallet_receipts.sql"));
  await transaction(pool, async (client) => {
    await client.query(
      "CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of legacyMigrations) {
      await client.query(
        await readFile(new URL(name, migrationDirectory), "utf8"),
      );
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        name,
      ]);
    }
  });
  const actorId = (
    await pool.query<{ id: number }>(
      "INSERT INTO users(name,display_name,email,password_hash) VALUES('Foundation actor','Foundation actor','account-statistics@local.test','unused-by-sql-fixture') RETURNING id",
    )
  ).rows[0].id;
  const createCompany = async (name: string) =>
    (
      await pool.query<{ id: number }>(
        "INSERT INTO companies(name,created_by) VALUES($1,$2) RETURNING id",
        [name, actorId],
      )
    ).rows[0].id;
  const companyId = await createCompany("Legacy statistics company");
  const otherCompanyId = await createCompany("Isolated statistics company");
  let accountCode = 9000000000n;
  const createAccount = async (
    company: number,
    kind: "posting" | "group" = "posting",
  ) =>
    (
      await pool.query<{ id: number }>(
        "INSERT INTO accounts(company_id,code,name,kind,category,normal_side,created_by) VALUES($1,$2,$3,$4,'asset','debit',$5) RETURNING id",
        [
          company,
          (++accountCode).toString(),
          `Foundation ${kind}`,
          kind,
          actorId,
        ],
      )
    ).rows[0].id;
  const accountId = await createAccount(companyId);
  const groupId = await createAccount(companyId, "group");
  const otherAccountId = await createAccount(otherCompanyId);
  const createCurrency = async (company: number, code = "YER") =>
    (
      await pool.query<{ id: number }>(
        "INSERT INTO company_currencies(company_id,code,name,decimal_places,created_by) VALUES($1,$2,'Foundation currency',2,$3) RETURNING id",
        [company, code, actorId],
      )
    ).rows[0].id;
  return {
    pool,
    actorId,
    companyId,
    otherCompanyId,
    accountId,
    groupId,
    otherAccountId,
    createAccount,
    createCompany,
    createCurrency,
  };
}

async function rowSnapshot(pool: Pool, companyId: number, accountId: number) {
  return (
    await pool.query<{ snapshot: string }>(
      "SELECT to_jsonb(s)::text AS snapshot FROM account_statistics s WHERE company_id=$1 AND account_id=$2",
      [companyId, accountId],
    )
  ).rows[0]?.snapshot;
}

function assertUncomputed(row: QueryResultRow) {
  assert.equal(String(row.source_revision), "0");
  assert.equal(row.policy_version, 1);
  for (const family of summaryFamilies) {
    assert.equal(row[`${family}_state`], "uncomputed");
    assert.equal(row[`${family}_computed_revision`], null);
    assert.equal(row[`${family}_as_of_date`], null);
    assert.equal(row[`${family}_computed_at`], null);
  }
}

async function rejectsSql(
  pool: Pool,
  sql: string,
  values: unknown[],
  code: string,
) {
  await assert.rejects(pool.query(sql, values), (error: unknown) => {
    assert(error && typeof error === "object" && "code" in error);
    assert.equal(error.code, code);
    return true;
  });
}

test("account statistics foundation upgrades posting accounts without inventing computed history", async (t) => {
  const f = await fixture(t);
  const mastersBefore = (
    await f.pool.query<{ snapshot: string }>(
      "SELECT to_jsonb(a)::text AS snapshot FROM accounts a ORDER BY id",
    )
  ).rows;
  assert.equal(
    (await f.pool.query("SELECT 1 FROM company_currencies")).rowCount,
    0,
  );
  await migrateFoundation(f.pool);
  const initial = (
    await f.pool.query("SELECT * FROM account_statistics ORDER BY account_id")
  ).rows;
  assert.deepEqual(
    initial.map((row) => [row.company_id, row.account_id]),
    [
      [f.companyId, f.accountId],
      [f.otherCompanyId, f.otherAccountId],
    ],
    "Only existing posting accounts receive a foundation row",
  );
  initial.forEach(assertUncomputed);
  assert.deepEqual(
    (
      await f.pool.query<{ snapshot: string }>(
        "SELECT to_jsonb(a)::text AS snapshot FROM accounts a ORDER BY id",
      )
    ).rows,
    mastersBefore,
    "Backfill must not change existing account master data",
  );

  const newCompanyId = await f.createCompany("Accounts precede currencies");
  const newPostingId = await f.createAccount(newCompanyId);
  const newGroupId = await f.createAccount(newCompanyId, "group");
  const added = (
    await f.pool.query(
      "SELECT * FROM account_statistics WHERE company_id=$1 ORDER BY account_id",
      [newCompanyId],
    )
  ).rows;
  assert.equal(added.length, 1);
  assert.equal(added[0].account_id, newPostingId);
  assertUncomputed(added[0]);
  assert.equal(
    (
      await f.pool.query(
        "SELECT 1 FROM company_currencies WHERE company_id=$1",
        [newCompanyId],
      )
    ).rowCount,
    0,
    "Account creation must not require or invent a currency",
  );

  await f.pool.query(
    `UPDATE account_statistics SET source_revision=12,policy_version=3,
      balance_state='ready',balance_computed_revision=12,
      balance_as_of_date=DATE '2026-10-16',balance_computed_at=TIMESTAMPTZ '2026-10-16 09:00:00+00',
      activity_state='stale',activity_computed_revision=8,
      activity_as_of_date=DATE '2026-10-15',activity_computed_at=TIMESTAMPTZ '2026-10-15 09:00:00+00'
      WHERE company_id=$1 AND account_id=$2`,
    [f.companyId, f.accountId],
  );
  const beforeInitialize = await rowSnapshot(f.pool, f.companyId, f.accountId);
  await f.pool.query("SELECT initialize_account_statistics($1,$2)", [
    f.companyId,
    f.accountId,
  ]);
  await f.pool.query("SELECT initialize_account_statistics($1,$2)", [
    f.companyId,
    f.groupId,
  ]);
  await f.pool.query("SELECT initialize_account_statistics($1,$2)", [
    newCompanyId,
    newGroupId,
  ]);
  await migrateFoundation(f.pool);
  assert.equal(
    await rowSnapshot(f.pool, f.companyId, f.accountId),
    beforeInitialize,
    "Initialization and repeated startup preserve all existing metadata exactly",
  );
  assert.equal(
    (await f.pool.query("SELECT 1 FROM account_statistics")).rowCount,
    3,
    "Repeated initialization neither duplicates posting rows nor creates group rows",
  );
  for (const table of [
    "account_daily_activity",
    "account_balance_followups",
    "account_balance_approvals",
  ]) {
    assert.equal(
      (await f.pool.query(`SELECT 1 FROM ${table}`)).rowCount,
      0,
      "Migration, account creation and initialization never synthesize activity or human actions",
    );
  }

  await rejectsSql(
    f.pool,
    "UPDATE account_statistics SET commerce_computed_revision=0 WHERE company_id=$1 AND account_id=$2",
    [f.companyId, f.accountId],
    "23514",
  );
  await rejectsSql(
    f.pool,
    "UPDATE account_statistics SET balance_computed_revision=11 WHERE company_id=$1 AND account_id=$2",
    [f.companyId, f.accountId],
    "23514",
  );
  await rejectsSql(
    f.pool,
    "UPDATE account_statistics SET activity_computed_revision=13 WHERE company_id=$1 AND account_id=$2",
    [f.companyId, f.accountId],
    "23514",
  );
  await rejectsSql(
    f.pool,
    "INSERT INTO account_statistics(company_id,account_id) VALUES($1,$2)",
    [f.companyId, f.otherAccountId],
    "23514",
  );
  await rejectsSql(
    f.pool,
    "INSERT INTO account_statistics(company_id,account_id) VALUES($1,$2)",
    [f.companyId, f.groupId],
    "23514",
  );
  await rejectsSql(
    f.pool,
    "UPDATE accounts SET kind='group' WHERE company_id=$1 AND id=$2",
    [f.companyId, f.accountId],
    "23514",
  );

  const currencyId = await f.createCurrency(f.companyId);
  const otherCurrencyId = await f.createCurrency(f.otherCompanyId);
  const nonBaseCurrencyId = await f.createCurrency(f.companyId, "SAR");
  await f.pool.query(
    "INSERT INTO finance_settings(company_id,base_currency_id) VALUES($1,$2),($3,$4)",
    [f.companyId, currencyId, f.otherCompanyId, otherCurrencyId],
  );
  // Daily rows are future projections: tests insert them explicitly, never by
  // recording pretend invoices or by asking initialization to calculate totals.
  await f.pool.query(
    `INSERT INTO account_daily_activity(
      company_id,account_id,document_date,currency_id,family,base_currency_id,
      document_count,source_revision
    ) VALUES($1,$2,DATE '2026-10-16',$3,'activity',$3,$4,12)`,
    [f.companyId, f.accountId, currencyId, "9007199254740993"],
  );
  await f.pool.query(
    `INSERT INTO account_daily_activity(
      company_id,account_id,document_date,currency_id,family,base_currency_id,
      document_count,amount,base_amount,base_debit,base_credit,source_revision
    ) VALUES($1,$2,DATE '2026-10-16',$3,'ledger',$3,1,$4,$4,0,$5,12)`,
    [
      f.companyId,
      f.accountId,
      currencyId,
      "-1234567890123456789012.34",
      "1234567890123456789012.34",
    ],
  );
  const explicitDaily = (
    await f.pool.query<{
      family: string;
      document_count: string;
      amount: string | null;
      base_amount: string | null;
    }>(
      "SELECT family,document_count::text,amount::text,base_amount::text FROM account_daily_activity WHERE company_id=$1 ORDER BY family",
      [f.companyId],
    )
  ).rows;
  assert.deepEqual(explicitDaily, [
    {
      family: "activity",
      document_count: "9007199254740993",
      amount: null,
      base_amount: null,
    },
    {
      family: "ledger",
      document_count: "1",
      amount: "-1234567890123456789012.340000",
      base_amount: "-1234567890123456789012.340000",
    },
  ]);
  await f.pool.query(
    `INSERT INTO account_daily_activity(
      company_id,account_id,document_date,currency_id,family,base_currency_id,
      document_count,amount,base_amount,source_revision
    ) VALUES($1,$2,DATE '2026-10-16',$3,'purchase_cash',$3,1,-25.5,-25.5,12)`,
    [f.companyId, f.accountId, currencyId],
  );
  assert.equal(
    (
      await f.pool.query<{ total: string }>(
        "SELECT sum(base_amount)::text AS total FROM account_daily_activity WHERE company_id=$1 AND account_id=$2 AND family='purchase_cash'",
        [f.companyId, f.accountId],
      )
    ).rows[0].total,
    "-25.500000",
    "Cash purchases have their own signed bucket rather than being added to purchase totals twice",
  );
  const dailyInsert = `INSERT INTO account_daily_activity(
    company_id,account_id,document_date,currency_id,family,base_currency_id,
    document_count,source_revision
  ) VALUES($1,$2,DATE '2026-10-17',$3,'activity',$4,1,0)`;
  await rejectsSql(
    f.pool,
    dailyInsert,
    [f.companyId, f.otherAccountId, currencyId, currencyId],
    "23503",
  );
  await rejectsSql(
    f.pool,
    dailyInsert,
    [f.companyId, f.accountId, otherCurrencyId, currencyId],
    "23503",
  );
  await rejectsSql(
    f.pool,
    dailyInsert,
    [f.companyId, f.accountId, currencyId, otherCurrencyId],
    "23503",
  );
  await rejectsSql(
    f.pool,
    "UPDATE account_daily_activity SET amount=1 WHERE company_id=$1 AND family='activity'",
    [f.companyId],
    "23514",
  );
  await rejectsSql(
    f.pool,
    "UPDATE account_daily_activity SET base_amount=1 WHERE company_id=$1 AND family='ledger'",
    [f.companyId],
    "23514",
  );

  const followUpKey = randomUUID();
  const secondAccountId = await f.createAccount(f.companyId);
  const followUpInsert = `INSERT INTO account_balance_followups(
    company_id,account_id,followed_up_at,created_by,note,idempotency_key,request_payload
  ) VALUES($1,$2,TIMESTAMPTZ '2026-10-16 10:00:00+00',$3,'متابعة بشرية مسجلة',$4,'{"method":"manual"}'::jsonb)
  RETURNING id`;
  const followUpId = (
    await f.pool.query<{ id: number }>(followUpInsert, [
      f.companyId,
      f.accountId,
      f.actorId,
      followUpKey,
    ])
  ).rows[0].id;
  await rejectsSql(
    f.pool,
    followUpInsert,
    [f.companyId, secondAccountId, f.actorId, followUpKey],
    "23505",
  );
  // UUID scope is the company, not a global key shared by all companies.
  await f.pool.query(followUpInsert, [
    f.otherCompanyId,
    f.otherAccountId,
    f.actorId,
    followUpKey,
  ]);
  await rejectsSql(
    f.pool,
    followUpInsert,
    [f.companyId, f.otherAccountId, f.actorId, randomUUID()],
    "23503",
  );
  const approvalKey = randomUUID();
  const approvalInsert = `INSERT INTO account_balance_approvals(
    company_id,account_id,balance_date,balance_base,base_currency_id,
    base_currency_code,base_decimal_places,source_revision,policy_version,
    created_by,note,idempotency_key,request_payload
  ) VALUES($1,$2,DATE '2026-10-16','-1234567890123456789012.34',$3,$6,$7,12,3,$4,'اعتماد مستقل',$5,'{"cutoff":"2026-10-16"}'::jsonb)
  RETURNING id`;
  const approvalId = (
    await f.pool.query<{ id: number }>(approvalInsert, [
      f.companyId,
      f.accountId,
      currencyId,
      f.actorId,
      approvalKey,
      "YER",
      2,
    ])
  ).rows[0].id;
  await rejectsSql(
    f.pool,
    approvalInsert,
    [
      f.companyId,
      secondAccountId,
      currencyId,
      f.actorId,
      approvalKey,
      "YER",
      2,
    ],
    "23505",
  );
  await f.pool.query(approvalInsert, [
    f.otherCompanyId,
    f.otherAccountId,
    otherCurrencyId,
    f.actorId,
    approvalKey,
    "YER",
    2,
  ]);
  await rejectsSql(
    f.pool,
    approvalInsert,
    [
      f.companyId,
      f.otherAccountId,
      currencyId,
      f.actorId,
      randomUUID(),
      "YER",
      2,
    ],
    "23503",
  );
  await rejectsSql(
    f.pool,
    approvalInsert,
    [
      f.companyId,
      f.accountId,
      otherCurrencyId,
      f.actorId,
      randomUUID(),
      "YER",
      2,
    ],
    "23514",
  );
  // Matching a real local currency is insufficient: the snapshot must use the
  // company's actual base currency, with its exact code and display precision.
  await rejectsSql(
    f.pool,
    approvalInsert,
    [
      f.companyId,
      f.accountId,
      nonBaseCurrencyId,
      f.actorId,
      randomUUID(),
      "SAR",
      2,
    ],
    "23514",
  );
  await rejectsSql(
    f.pool,
    approvalInsert,
    [f.companyId, f.accountId, currencyId, f.actorId, randomUUID(), "USD", 2],
    "23514",
  );
  await rejectsSql(
    f.pool,
    approvalInsert,
    [f.companyId, f.accountId, currencyId, f.actorId, randomUUID(), "YER", 3],
    "23514",
  );
  await rejectsSql(
    f.pool,
    approvalInsert,
    [newCompanyId, newPostingId, currencyId, f.actorId, randomUUID(), "YER", 2],
    "23514",
  );
  assert.equal(
    (
      await f.pool.query<{ balance_base: string }>(
        "SELECT balance_base::text FROM account_balance_approvals WHERE id=$1",
        [approvalId],
      )
    ).rows[0].balance_base,
    "-1234567890123456789012.340000",
  );
  for (const [table, eventId] of [
    ["account_balance_followups", followUpId],
    ["account_balance_approvals", approvalId],
  ] as const) {
    await rejectsSql(
      f.pool,
      `UPDATE ${table} SET note='rewritten history' WHERE id=$1`,
      [eventId],
      "23514",
    );
    await rejectsSql(
      f.pool,
      `DELETE FROM ${table} WHERE id=$1`,
      [eventId],
      "23514",
    );
  }

  const preservedRows = async () => {
    const result: Record<string, string[]> = {};
    for (const [table, order] of [
      ["account_statistics", "company_id,account_id"],
      [
        "account_daily_activity",
        "company_id,account_id,document_date,currency_id,family",
      ],
      ["account_balance_followups", "id"],
      ["account_balance_approvals", "id"],
    ]) {
      result[table] = (
        await f.pool.query<{ snapshot: string }>(
          `SELECT to_jsonb(r)::text AS snapshot FROM ${table} r ORDER BY ${order}`,
        )
      ).rows.map((row) => row.snapshot);
    }
    return result;
  };
  const explicitlyStored = await preservedRows();
  await f.pool.query("SELECT initialize_account_statistics($1,$2)", [
    f.companyId,
    f.accountId,
  ]);
  await migrateFoundation(f.pool);
  assert.deepEqual(
    await preservedRows(),
    explicitlyStored,
    "Initialization and migration retries preserve explicit daily facts and immutable events",
  );
});
