import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { Pool } from "pg";
import { ZodError } from "zod";
import { businessRoutes } from "../apps/api/src/business-routes.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { transaction } from "../apps/api/src/db.ts";
import { HttpError } from "../apps/api/src/errors.ts";
import { readAccountOperations } from "../apps/api/src/services/account-operations.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { permissionRequest } from "../apps/api/src/services/permission-rules.ts";
import type {
  Account,
  AccountOperationVisibility,
  Branch,
  Company,
  CompanyCurrency,
  Item,
  Location,
  Page,
} from "../packages/contracts/src/index.ts";
import type {
  Invoice,
  InvoiceInput,
} from "../packages/contracts/src/commerce.ts";

// Never inherit the application DATABASE_URL. The real upgrade runs only in a
// disposable schema on a dedicated, explicitly local test target.
const databaseUrl =
  process.env.ACCOUNT_ACTIVITY_STATISTICS_TEST_DATABASE_URL ??
  DEFAULT_DATABASE_URL;
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
  "Account-activity upgrade tests require an explicitly local PostgreSQL target",
);

const migrations = new URL("../apps/api/migrations/", import.meta.url);
async function migrateThrough(pool: Pool, last: number) {
  const names = (await readdir(migrations))
    .filter(
      (name) =>
        /^\d+_[a-z_]+\.sql$/.test(name) && Number(name.split("_")[0]) <= last,
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
      await client.query(await readFile(new URL(name, migrations), "utf8"));
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        name,
      ]);
    }
  });
}

async function fixture(t: TestContext) {
  const schema = `activity_upgrade_${randomUUID().replaceAll("-", "")}`;
  const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
  let pool: Pool | undefined;
  let server: Server | undefined;
  t.after(async () => {
    try {
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      await pool?.end();
    } finally {
      try {
        await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await bootstrap.end();
      }
    }
  });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 3,
  });
  const scoped = pool;
  await migrateThrough(scoped, 87);
  assert.equal(
    (await scoped.query("SELECT max(version) AS latest FROM schema_migrations"))
      .rows[0]!.latest,
    "087_account_balance_permissions.sql",
  );
  const owner = await provisionOwner(scoped, {
    name: "Activity upgrade owner",
    displayName: "Activity upgrade owner",
    email: "owner@activity-upgrade.test",
    password: "Local-activity-upgrade-passphrase-2026",
  });

  // This fixture intentionally stays on the historical 087 accounting
  // schema while calling CURRENT item-master APIs. Supply only the new
  // display-note columns, without applying later accounting migrations or
  // changing the historical posted invoice structures under test.
  await scoped.query("ALTER TABLE items ADD COLUMN sale_notes text NOT NULL DEFAULT ''");
  await scoped.query("ALTER TABLE item_compositions ADD COLUMN sale_notes text NOT NULL DEFAULT ''");

  // Only the test's HTTP authentication transport is stubbed. All company,
  // master and invoice writes use the existing business routes, authorization,
  // posting services, triggers and audit transactions at the actual 087 schema.
  const app = express();
  app.use(express.json());
  app.use("/api", (req, _res, next) => {
    req.auth = { user: owner, tokenHash: "local-test", csrf: "local-test" };
    permissionRequest.run(req, next);
  });
  app.use("/api", businessRoutes(scoped));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    res
      .status(
        error instanceof HttpError
          ? error.status
          : error instanceof ZodError
            ? 400
            : 500,
      )
      .json({
        error: error instanceof Error ? error.message : String(error),
      });
  };
  app.use(errors);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/api`;
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    expected = 200,
  ) {
    const response = await fetch(root + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result: unknown = await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${path}: ${JSON.stringify(result)}`,
    );
    return result as T;
  }
  return { pool: scoped, request };
}

const visibility: AccountOperationVisibility = {
  ledger: true,
  activity: true,
  sale: true,
  purchase: true,
  purchaseCash: true,
  payment: true,
  receipt: true,
};

test("087 to 088 preserves unknown legacy zero cash history and snapshots new zero purchases", async (t) => {
  const f = await fixture(t);
  const company = (
    await f.request<{ company: Company }>(
      "POST",
      "/companies",
      { name: "Real activity upgrade", phone: "", address: "" },
      201,
    )
  ).company;
  const base = `/companies/${company.id}`;
  const currency = (
    await f.request<Page<CompanyCurrency>>("GET", `${base}/currencies`)
  ).items.find((row) => row.code === "YER")!;
  const branch = (await f.request<Page<Branch>>("GET", `${base}/branches`))
    .items[0]!;
  const location = (await f.request<Page<Location>>("GET", `${base}/locations`))
    .items[0]!;
  assert(currency && branch && location);
  async function account(name: string, cashOrBank: boolean) {
    return (
      await f.request<{ account: Account }>(
        "POST",
        `${base}/accounts`,
        {
          name,
          parentId: null,
          kind: "posting",
          category: cashOrBank ? "asset" : "liability",
          normalSide: cashOrBank ? "debit" : "credit",
          cashOrBank,
        },
        201,
      )
    ).account;
  }
  const supplierA = await account("Supplier A", false);
  const supplierB = await account("Supplier B", false);
  const ordinaryCash = await account("Protected ordinary cash", true);
  const legacyZeroCash = await account("Legacy zero-only cash", true);
  const newZeroCash = await account("New zero-only cash", true);
  const item = (
    await f.request<{ item: Item }>(
      "POST",
      `${base}/items`,
      {
        idempotencyKey: randomUUID(),
        name: "Upgrade item",
        unit1Name: "Box",
        unit2Name: "Pack",
        unit3Name: "Piece",
        factor2: 1,
        factor3: 1,
        purchaseFactor: 1,
        salePrice1: "10",
        salePrice2: "10",
        salePrice3: "10",
        purchasePrice: "10",
        hasExpiry: false,
        currencyId: currency.id,
      },
      201,
    )
  ).item;
  const day = (
    await f.pool.query(
      "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS day",
    )
  ).rows[0]!.day as string;
  async function purchase(
    counterparty: Account,
    supplier: Account,
    amount: string,
    free = false,
  ) {
    const input: InvoiceInput = {
      idempotencyKey: randomUUID(),
      kind: "purchase",
      documentDate: day,
      currencyId: currency.id,
      branchId: branch.id,
      locationId: location.id,
      counterpartyAccountId: counterparty.id,
      supplierAccountId: supplier.id,
      discount: free ? amount : "0",
      lines: [{ itemId: item.id, unit: 1, quantity: "1", unitPrice: amount }],
    };
    return (
      await f.request<{ invoice: Invoice }>(
        "POST",
        `${base}/invoices`,
        input,
        201,
      )
    ).invoice;
  }
  const legacyZero = await purchase(legacyZeroCash, supplierA, "20", true);
  const legacyCash = await purchase(ordinaryCash, supplierA, "10");
  const legacyCredit = await purchase(supplierB, supplierB, "15");
  assert.equal(legacyZero.financialDocumentId, null);
  assert.equal(legacyZero.total, "0");
  assert(legacyCash.financialDocumentId && legacyCredit.financialDocumentId);
  const before = (
    await f.pool.query("SELECT to_jsonb(i) AS row FROM invoices i ORDER BY id")
  ).rows;
  assert(before.every(({ row }) => !("counterparty_cash_snapshot" in row)));

  await migrateThrough(f.pool, 88);
  assert.equal(
    (await f.pool.query("SELECT max(version) AS latest FROM schema_migrations"))
      .rows[0]!.latest,
    "088_account_activity_statistics.sql",
  );
  assert.deepEqual(
    (
      await f.pool.query(
        "SELECT to_jsonb(i)-'counterparty_cash_snapshot' AS row FROM invoices i ORDER BY id",
      )
    ).rows,
    before,
    "Upgrading must not rewrite protected posted invoice history",
  );
  assert(
    (
      await f.pool.query("SELECT counterparty_cash_snapshot FROM invoices")
    ).rows.every((row) => row.counterparty_cash_snapshot === null),
    "Legacy snapshots stay NULL; proofs belong to the read projection",
  );
  async function events(invoiceId: number, family = "purchase") {
    return (
      await f.pool.query(
        `SELECT account_id,cash_classification_known FROM account_operation_events
      WHERE company_id=$1 AND source_kind='invoice' AND source_id=$2 AND family=$3`,
        [company.id, invoiceId, family],
      )
    ).rows;
  }
  assert.deepEqual(await events(legacyZero.id), [
    { account_id: supplierA.id, cash_classification_known: false },
  ]);
  assert.deepEqual(await events(legacyCash.id), [
    { account_id: supplierA.id, cash_classification_known: true },
  ]);
  assert.deepEqual(await events(legacyCash.id, "purchase_cash"), [
    { account_id: supplierA.id, cash_classification_known: true },
  ]);
  assert.deepEqual(await events(legacyCredit.id), [
    { account_id: supplierB.id, cash_classification_known: true },
  ]);
  assert.deepEqual(await events(legacyCredit.id, "purchase_cash"), []);
  await f.request(
    "PATCH",
    `${base}/accounts/${ordinaryCash.id}`,
    { cashOrBank: false },
    409,
  );

  // A zero-only legacy counterparty can still change classification. Its new
  // master value cannot manufacture knowledge of the historical settlement.
  await f.request("PATCH", `${base}/accounts/${legacyZeroCash.id}`, {
    cashOrBank: false,
  });
  assert.deepEqual(await events(legacyZero.id), [
    { account_id: supplierA.id, cash_classification_known: false },
  ]);
  const currentZero = await purchase(newZeroCash, supplierA, "30", true);
  assert.equal(currentZero.financialDocumentId, null);
  assert.equal(
    (
      await f.pool.query(
        "SELECT counterparty_cash_snapshot FROM invoices WHERE id=$1",
        [currentZero.id],
      )
    ).rows[0]!.counterparty_cash_snapshot,
    true,
    "New zero-net postings snapshot cash without requiring a dummy journal",
  );
  await f.request("PATCH", `${base}/accounts/${newZeroCash.id}`, {
    cashOrBank: false,
  });
  assert.deepEqual(await events(currentZero.id, "purchase_cash"), [
    { account_id: supplierA.id, cash_classification_known: true },
  ]);
  for (const invoiceId of [legacyZero.id, currentZero.id])
    await assert.rejects(
      f.pool.query(
        "UPDATE invoices SET counterparty_cash_snapshot=NOT COALESCE(counterparty_cash_snapshot,false) WHERE id=$1",
        [invoiceId],
      ),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23514",
      "Legacy NULL and new snapshots both remain protected by posted immutability",
    );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::text AS count FROM account_daily_activity",
      )
    ).rows[0]!.count,
    "0",
    "Neither upgrade nor source posting eagerly materializes daily history",
  );
  async function stats(accountId: number) {
    return (
      await transaction(f.pool, (client) =>
        readAccountOperations(client, company.id, accountId, day, visibility),
      )
    ).operations;
  }
  const a = await stats(supplierA.id);
  assert.equal(a.purchase!.documentsAllTime, "3");
  assert.equal(a.purchase!.totalsBase.fourMonths, "10");
  assert.equal(a.purchase!.knownCashPurchasesFourMonthsBase, "10");
  assert.equal(a.purchase!.cashPurchasesFourMonthsBase, null);
  assert.deepEqual(a.purchase!.quality, {
    cashClassificationUnknownFourMonths: "1",
    supplierConflictsFourMonths: "0",
    companyUnknownSupplierDocumentsFourMonths: "0",
  });
  const b = await stats(supplierB.id);
  assert.equal(b.purchase!.documentsAllTime, "1");
  assert.equal(b.purchase!.totalsBase.fourMonths, "15");
  assert.equal(b.purchase!.knownCashPurchasesFourMonthsBase, "0");
  assert.equal(b.purchase!.cashPurchasesFourMonthsBase, "0");
  assert.equal(
    b.purchase!.quality.cashClassificationUnknownFourMonths,
    "0",
    "Supplier A's unknown legacy settlement must not make Supplier B incomplete",
  );
  assert.equal(
    (
      await f.pool.query(
        `SELECT document_count::text AS count FROM account_daily_activity
    WHERE company_id=$1 AND account_id=$2 AND family='purchase_cash'`,
        [company.id, supplierA.id],
      )
    ).rows[0]!.count,
    "2",
    "Known cash counts include the new zero snapshot after its master classification changes",
  );
});
