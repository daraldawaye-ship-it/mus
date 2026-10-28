import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createDatabase } from "../apps/api/src/db.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";

const sourceSystem = "dar-aldawa-legacy-2026-10";
const runKey = "f03ead4a-40d9-4713-811c-6a366b7ec6c8";
const migrationUrl = new URL("../apps/api/migrations/145_limit_pending_historical_sales.sql", import.meta.url);

async function fixture(t: TestContext) {
  // Use only the disposable local database, never an inherited DATABASE_URL.
  const schema = `sales_window_${randomUUID().replaceAll("-", "")}`;
  const pool = await createDatabase(DEFAULT_DATABASE_URL, schema);
  t.after(async () => {
    await pool.end();
    const cleanup = new Pool({ connectionString: DEFAULT_DATABASE_URL });
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });
  await pool.query(`INSERT INTO users(name,display_name,email,password_hash,owner)
    VALUES('Local owner','Local owner','sales-window@fixture.test','not-a-production-hash',true)`);
  await pool.query(`INSERT INTO companies(name,created_by)
    VALUES('Other company',1),('Authorized historical company',1),('Isolated company',1)`);
  await pool.query(`INSERT INTO legacy_import_runs
    (company_id,idempotency_key,source_system,created_by,request_payload,round_unit_prices,status,initial_pending)
    VALUES(2,$1,$2,1,'{}',true,'paused',9)`, [runKey, sourceSystem]);
  return pool;
}

async function stage(pool: Pool, sourceId: string, kind: string, date: string, options: {
  companyId?: number; source?: string; status?: string; sourceKind?: string;
} = {}) {
  const document = { type: options.sourceKind ?? "invoice", sourceId,
    payload: { kind, documentDate: date, lines: [{ quantity: "0.5000001", unitPrice: "571.81818" }] },
    sourceRows: [{ sourceId, originalNull: null, originalText: "حفظ النص الأصلي" }] };
  const hash = createHash("sha256").update(JSON.stringify(document)).digest("hex");
  await pool.query(`INSERT INTO legacy_import_staging
    (company_id,source_system,source_kind,source_id,posting_date,source_document,request_hash,status,error_message,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,
  [options.companyId ?? 2, options.source ?? sourceSystem, options.sourceKind ?? "invoice", sourceId,
    date, JSON.stringify(document), hash, options.status ?? "pending",
    options.status === "failed" ? "Original incompatible source, preserve for manual repair" : null]);
}

async function snapshot(pool: Pool) {
  return (await pool.query(`SELECT company_id,source_system,source_kind,source_id,
    posting_date::text,source_document,request_hash,status,error_message
    FROM legacy_import_staging ORDER BY company_id,source_system,source_kind,source_id`)).rows;
}

async function businessCounts(pool: Pool) {
  return (await pool.query(`SELECT
    (SELECT count(*)::integer FROM invoices) AS invoices,
    (SELECT count(*)::integer FROM invoice_lines) AS invoice_lines,
    (SELECT count(*)::integer FROM financial_documents) AS journals,
    (SELECT count(*)::integer FROM financial_document_lines) AS journal_lines,
    (SELECT count(*)::integer FROM stock_movements) AS movements,
    (SELECT count(*)::integer FROM stock_balances) AS balances,
    (SELECT count(*)::integer FROM transaction_source_imports) AS provenance`)).rows[0];
}

test("pending sales window excludes only older sales, preserves purchases, source payloads and completed history", async t => {
  const pool = await fixture(t);
  await stage(pool, "sale-old", "sale", "2026-06-27");
  await stage(pool, "sale-boundary", "sale", "2026-06-28");
  await stage(pool, "sale-recent", "sale", "2026-10-28");
  await stage(pool, "purchase-old", "purchase", "2013-09-06");
  await stage(pool, "purchase-recent", "purchase", "2026-10-28");
  await stage(pool, "sale-completed", "sale", "2026-01-01", { status: "completed" });
  await stage(pool, "sale-failed", "sale", "2026-01-01", { status: "failed" });
  await stage(pool, "other-source", "sale", "2026-01-01", { source: "unrelated-source" });
  await stage(pool, "other-company", "sale", "2026-01-01", { companyId: 3 });
  await stage(pool, "voucher", "sale", "2026-01-01", { sourceKind: "voucher" });
  const before = await snapshot(pool), beforeBusiness = await businessCounts(pool);
  await pool.query(await readFile(migrationUrl, "utf8"));
  const after = await snapshot(pool);
  assert.equal(after.length, before.length, "no source rows are erased");
  for (let i = 0; i < before.length; i++) {
    const old = before[i]!, current = after[i]!;
    if (old.source_id === "sale-old") {
      assert.equal(current.status, "excluded");
      assert.ok(current.error_message, "exclusion retains a reason");
      assert.deepEqual({ ...current, status: old.status, error_message: old.error_message }, old,
        "exclusion must preserve exact raw JSON, source identity, source date and hash");
    } else assert.deepEqual(current, old, `unrelated or retained source changed: ${old.source_id}`);
  }
  assert.deepEqual(await businessCounts(pool), beforeBusiness, "scope changes never post or delete business data");
  const run = (await pool.query(`SELECT status,excluded_documents,sales_from_date::text
    FROM legacy_import_runs WHERE company_id=2 AND idempotency_key=$1`, [runKey])).rows[0];
  assert.deepEqual(run, { status: "paused", excluded_documents: 1, sales_from_date: "2026-06-28" });
  const eligible = (await pool.query(`SELECT source_id FROM legacy_import_staging
    WHERE company_id=2 AND source_system=$1 AND source_kind='invoice' AND status='pending'
    ORDER BY source_id`, [sourceSystem])).rows.map(row => row.source_id);
  assert.deepEqual(eligible, ["purchase-old", "purchase-recent", "sale-boundary", "sale-recent"]);
  await pool.query(await readFile(migrationUrl, "utf8"));
  assert.deepEqual(await snapshot(pool), after, "reapplication must not alter preserved source data or exclusion reason");
  assert.equal((await pool.query(`SELECT excluded_documents FROM legacy_import_runs
    WHERE company_id=2 AND idempotency_key=$1`, [runKey])).rows[0].excluded_documents, 1,
  "reapplying must not count an excluded row twice");
});

test("sales-window scope requires the authorized import to be paused", async t => {
  const pool = await fixture(t);
  await stage(pool, "sale-old", "sale", "2026-06-27");
  await pool.query("UPDATE legacy_import_runs SET status='running' WHERE company_id=2");
  const before = await snapshot(pool);
  await assert.rejects(pool.query(await readFile(migrationUrl, "utf8")));
  assert.deepEqual(await snapshot(pool), before, "a rejected scope change must leave intake unchanged");
  assert.equal((await pool.query("SELECT status FROM legacy_import_runs WHERE company_id=2")).rows[0].status, "running");
});
