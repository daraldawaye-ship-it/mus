import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { transaction } from "../apps/api/src/db.ts";
import { HttpError } from "../apps/api/src/errors.ts";
import { deleteCompanyTransactions } from "../apps/api/src/services/transaction-reset.ts";
import type {
  Account,
  Branch,
  Company,
  CompanyCurrency,
  Employee,
  FinancialDocument,
  Item,
  Location,
  Page,
  Permission,
  RewardTask,
  SessionResponse,
  WalletConversionPreview,
  WalletPolicy,
  EmployeeWalletAccount,
} from "../packages/contracts/src/index.ts";
import type { Invoice } from "../packages/contracts/src/commerce.ts";

// Intentionally ignore DATABASE_URL: these destructive checks use only an
// explicitly local PostgreSQL target and disposable, randomly named schemas.
const databaseUrl =
  process.env.TRANSACTION_RESET_TEST_DATABASE_URL ?? DEFAULT_DATABASE_URL;
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
  "Transaction-reset tests require an explicitly local PostgreSQL target",
);
const origin = "http://localhost";
const password = "Transaction-reset-disposable-test-passphrase-2026";

class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private readonly baseUrl: string) {}
  async request<T>(method: string, path: string, body?: unknown) {
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET") {
      headers.set("content-type", "application/json");
      headers.set("origin", origin);
      if (this.csrf) headers.set("x-csrf-token", this.csrf);
    }
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie())
      this.cookie = value.split(";", 1)[0]!;
    const result: unknown = await response.json();
    if (result && typeof result === "object" && "csrf" in result)
      this.csrf = (result as SessionResponse).csrf;
    return { status: response.status, body: result as T };
  }
  async ok<T>(method: string, path: string, body?: unknown, status = 200) {
    const result = await this.request<T>(method, path, body);
    assert.equal(
      result.status,
      status,
      `${method} ${path}: ${JSON.stringify(result.body)}`,
    );
    return result.body;
  }
}

type Preview = {
  companyId: number;
  companyName: string;
  snapshotHash: string;
  counts: Record<string, number>;
  blockers: string[];
  createsBackup: boolean;
  walletAdjustments: { employeeId: number; pointsToRemove: string }[];
};
type ResetResult = {
  deleted: Record<string, number>;
  remaining: Record<string, number>;
  replayed: boolean;
  createsBackup: boolean;
};
const payload = (preview: Preview) => ({
  idempotencyKey: randomUUID(),
  snapshotHash: preview.snapshotHash,
  confirmationCompanyName: preview.companyName,
  deleteAllTransactions: true,
});

async function fixture(t: TestContext) {
  const schema = `reset_test_${randomUUID().replaceAll("-", "")}`;
  const runtime = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: false,
  });
  const server: Server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try {
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });
  const user = await provisionOwner(runtime.pool, {
    name: "Reset owner",
    displayName: "Reset owner",
    email: "owner@reset.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  const company = async (name: string) =>
    (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        { name, phone: "", address: "" },
        201,
      )
    ).company;
  async function staff(companyId: number, permissions: Permission[] = []) {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>(
      "POST",
      "/auth/register",
      {
        name: "Reset employee",
        displayName: "Reset employee",
        email: `${randomUUID()}@reset.test`,
        phone: "",
        password,
      },
      201,
    );
    assert(session.user);
    const employee = (
      await owner.ok<{ employee: Employee }>(
        "POST",
        `/companies/${companyId}/employees`,
        {
          userId: session.user.id,
          name: "Reset employee",
          phone: "",
          role: "employee",
          active: true,
          permissions,
        },
        201,
      )
    ).employee;
    return { client, employee };
  }
  return {
    pool: runtime.pool,
    owner,
    user,
    company,
    staff,
    anonymous: new Client(baseUrl),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setup(f: Fixture, name: string) {
  const company = await f.company(name),
    base = `/companies/${company.id}`;
  const currencies = await f.owner.ok<Page<CompanyCurrency>>(
    "GET",
    base + "/currencies",
  );
  const currency = currencies.items.find((row) => row.code === "YER")!;
  const branch = (await f.owner.ok<Page<Branch>>("GET", base + "/branches"))
    .items[0]!;
  const location = (
    await f.owner.ok<Page<Location>>("GET", base + "/locations")
  ).items[0]!;
  async function account(code: string, name: string, cashOrBank: boolean) {
    return (
      await f.owner.ok<{ account: Account }>(
        "POST",
        base + "/accounts",
        {
          code,
          name,
          parentId: null,
          kind: "posting",
          category: "asset",
          normalSide: "debit",
          cashOrBank,
        },
        201,
      )
    ).account;
  }
  const cash = await account("0000000001", "Reset cash", true);
  const counterparty = await account(
    "0000000002",
    "Reset customer supplier",
    false,
  );
  const item = (
    await f.owner.ok<{ item: Item }>(
      "POST",
      base + "/items",
      {
        idempotencyKey: randomUUID(),
        name: "Reset item",
        unit1Name: "باكت",
        unit2Name: "شريط",
        unit3Name: "حبة",
        factor2: 1,
        factor3: 1,
        purchaseFactor: 1,
        salePrice1: "20",
        salePrice2: "20",
        salePrice3: "20",
        purchasePrice: "10",
        hasExpiry: false,
        currencyId: currency.id,
      },
      201,
    )
  ).item;
  async function invoice(
    kind: "sale" | "purchase" = "purchase",
    quantity = "10",
    client = f.owner,
  ) {
    return (
      await client.ok<{ invoice: Invoice }>(
        "POST",
        base + "/invoices",
        {
          idempotencyKey: randomUUID(),
          kind,
          documentDate: "2026-10-12",
          currencyId: currency.id,
          branchId: branch.id,
          locationId: location.id,
          counterpartyAccountId: counterparty.id,
          lines: [
            {
              itemId: item.id,
              unit: 1,
              quantity,
              ...(kind === "purchase" ? { unitPrice: "10" } : {}),
            },
          ],
        },
        201,
      )
    ).invoice;
  }
  async function document(
    kind: "receipt" | "journal" = "receipt",
    post = true,
  ) {
    const created = (
      await f.owner.ok<{ document: FinancialDocument }>(
        "POST",
        base + "/financial-documents",
        {
          idempotencyKey: randomUUID(),
          kind,
          documentDate: "2026-10-12",
          currencyId: currency.id,
          cashAccountId: kind === "receipt" ? cash.id : null,
          lines: [
            { accountId: cash.id, debit: "50", credit: "0" },
            { accountId: counterparty.id, debit: "0", credit: "50" },
          ],
        },
        201,
      )
    ).document;
    return post
      ? (
          await f.owner.ok<{ document: FinancialDocument }>(
            "POST",
            `${base}/financial-documents/${created.id}/post`,
            { revision: created.revision },
          )
        ).document
      : created;
  }
  const preview = () => f.owner.ok<Preview>("GET", base + "/transaction-reset");
  return {
    company,
    base,
    currency,
    branch,
    location,
    cash,
    counterparty,
    item,
    invoice,
    document,
    preview,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function stored(
  f: Fixture,
  companyId: number,
  tables: readonly string[],
) {
  const result: Record<string, unknown[]> = {};
  for (const table of tables)
    result[table] = (
      await f.pool.query(
        `SELECT to_jsonb(r) AS row FROM ${table} r WHERE company_id=$1 ORDER BY to_jsonb(r)::text`,
        [companyId],
      )
    ).rows.map((row) => row.row);
  return result;
}
const historyTables = [
  "invoices",
  "invoice_lines",
  "financial_documents",
  "financial_document_lines",
  "stock_operations",
  "stock_movements",
  "stock_balances",
] as const;
const masterTables = [
  "accounts",
  "items",
  "employees",
  "company_currencies",
  "branches",
  "locations",
  "inventory_settings",
  "finance_settings",
  "invoice_counters",
  "financial_document_counters",
] as const;

test("transaction reset requires owner, exact company confirmation, fresh contents and enabled pages", async (t) => {
  const f = await fixture(t),
    s = await setup(f, "Protected reset pharmacy");
  await s.invoice();
  const original = await s.preview(),
    input = payload(original);
  assert.equal(original.createsBackup, false);
  assert.equal(
    (await f.anonymous.request("GET", s.base + "/transaction-reset")).status,
    401,
  );
  const member = await f.staff(s.company.id, [
    "finance.manage",
    "finance.post",
    "commerce.manage",
    "inventory.post",
  ]);
  for (const general of [false, true]) {
    if (general)
      await f.owner.ok(
        "PATCH",
        `${s.base}/employees/${member.employee.id}/manager`,
        { isGeneralManager: true },
      );
    assert.equal(
      (await member.client.request("GET", s.base + "/transaction-reset"))
        .status,
      403,
    );
    assert.equal(
      (
        await member.client.request(
          "POST",
          s.base + "/transaction-reset",
          input,
        )
      ).status,
      403,
    );
  }
  const before = await stored(f, s.company.id, historyTables);
  assert.equal(
    (
      await f.owner.request("POST", s.base + "/transaction-reset", {
        ...input,
        confirmationCompanyName: original.companyName + " ",
      })
    ).status,
    409,
  );
  assert.deepEqual(await stored(f, s.company.id, historyTables), before);
  // Same row count, changed draft content must invalidate the snapshot too.
  const draft = await s.document("journal", false),
    stale = payload(await s.preview());
  await f.owner.ok("PATCH", `${s.base}/financial-documents/${draft.id}`, {
    kind: draft.kind,
    documentDate: draft.documentDate,
    currencyId: draft.currencyId,
    branchId: draft.branchId,
    cashAccountId: draft.cashAccountId,
    description: "Changed after preview",
    revision: draft.revision,
    lines: draft.lines.map((line) => ({
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
      description: line.description,
    })),
  });
  const updated = await stored(f, s.company.id, historyTables);
  assert.equal(
    (await f.owner.request("POST", s.base + "/transaction-reset", stale))
      .status,
    409,
  );
  assert.deepEqual(await stored(f, s.company.id, historyTables), updated);
  await f.owner.ok(
    "PUT",
    "/page-catalog/company.financial-documents/settings",
    {
      companyId: s.company.id,
      visible: true,
      enabled: false,
      order: 10,
      revision: null,
    },
  );
  assert.equal(
    (await f.owner.request("GET", s.base + "/transaction-reset")).status,
    403,
  );
  assert.equal(
    (await f.owner.request("POST", s.base + "/transaction-reset", stale))
      .status,
    403,
  );
  assert.deepEqual(await stored(f, s.company.id, historyTables), updated);
});

test("transaction reset atomically removes linked history, preserves masters and counters, and retries safely", async (t) => {
  const f = await fixture(t),
    s = await setup(f, "Cleared reset pharmacy"),
    other = await setup(f, "Untouched reset pharmacy");
  await other.invoice();
  await other.document();
  await s.invoice();
  await s.invoice("sale", "2");
  await s.invoice("sale", "-1");
  await s.document();
  await s.document("journal");
  await f.owner.ok(
    "POST",
    s.base + "/stock-adjustments",
    {
      idempotencyKey: randomUUID(),
      documentDate: "2026-10-12",
      itemId: s.item.id,
      locationId: s.location.id,
      countedQuantity: "10",
      expectedQuantitySmallest: "9",
      unit: 1,
      unitCostBase: "10",
    },
    201,
  );
  const preview = await s.preview(),
    input = payload(preview);
  assert.deepEqual(preview.blockers, []);
  assert(
    preview.counts.invoices! > 0 &&
      preview.counts.stockOperations! > 0 &&
      preview.counts.financialDocuments! > 0,
  );
  const oldHistory = await stored(f, s.company.id, historyTables);
  const masters = await stored(f, s.company.id, masterTables);
  const otherBefore = await stored(f, other.company.id, [
    ...historyTables,
    ...masterTables,
    "item_statistics",
    "stock_item_valuations",
  ]);
  const oldAudit = (
    await f.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE company_id=$1",
      [s.company.id],
    )
  ).rows[0]!.n;
  await f.pool.query(
    "CREATE FUNCTION reject_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='company.transactions.reset' THEN RAISE EXCEPTION 'test rejects reset audit'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER reject_reset_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_reset_audit()",
  );
  try {
    assert.equal(
      (await f.owner.request("POST", s.base + "/transaction-reset", input))
        .status,
      500,
    );
    assert.deepEqual(await stored(f, s.company.id, historyTables), oldHistory);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM company_transaction_resets WHERE company_id=$1",
          [s.company.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    await f.pool.query("DROP TRIGGER reject_reset_audit ON audit_events");
    await f.pool.query("DROP FUNCTION reject_reset_audit()");
  }
  // The audit-failure rollback must also roll back the maintenance capability.
  await assert.rejects(
    f.pool.query("DELETE FROM stock_movements WHERE company_id=$1", [
      s.company.id,
    ]),
    /immutable|cannot.*deleted/i,
  );
  const result = await f.owner.ok<ResetResult>(
    "POST",
    s.base + "/transaction-reset",
    input,
  );
  assert.equal(result.replayed, false);
  assert.equal(result.createsBackup, false);
  for (const key of [
    "invoices",
    "invoiceLines",
    "financialDocuments",
    "financialDocumentLines",
    "stockOperations",
    "stockMovements",
    "stockBalances",
  ])
    assert.equal(result.deleted[key], preview.counts[key]);
  for (const rows of Object.values(
    await stored(f, s.company.id, historyTables),
  ))
    assert.deepEqual(rows, []);
  assert.deepEqual(await stored(f, s.company.id, masterTables), masters);
  assert.deepEqual(
    await stored(f, other.company.id, [
      ...historyTables,
      ...masterTables,
      "item_statistics",
      "stock_item_valuations",
    ]),
    otherBefore,
  );
  const statistics = (
    await f.pool.query(
      "SELECT stock_total::text,stock_showroom::text,stock_warehouse::text,last_movement_id,last_sale_invoice_id,last_purchase_line_id,last_adjustment_movement_id FROM item_statistics WHERE company_id=$1",
      [s.company.id],
    )
  ).rows;
  assert.equal(statistics.length, 1);
  assert.deepEqual(statistics[0], {
    stock_total: "0",
    stock_showroom: "0",
    stock_warehouse: "0",
    last_movement_id: null,
    last_sale_invoice_id: null,
    last_purchase_line_id: null,
    last_adjustment_movement_id: null,
  });
  for (const row of (
    await f.pool.query(
      "SELECT quantity_smallest::text,value_base::text FROM stock_item_valuations WHERE company_id=$1",
      [s.company.id],
    )
  ).rows) {
    assert.equal(row.quantity_smallest, "0");
    assert.equal(Number(row.value_base), 0);
  }
  const balances = await f.owner.ok<
    Page<{ debit: string; credit: string; balance: string }>
  >("GET", s.base + "/account-balances?pageSize=100");
  assert(
    balances.items.every(
      (row) =>
        Number(row.debit) === 0 &&
        Number(row.credit) === 0 &&
        Number(row.balance) === 0,
    ),
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0]!.n,
    oldAudit + 1,
  );
  const later = await s.invoice();
  const nextCounter = (
    masters.invoice_counters![0] as { next_number: number | string }
  ).next_number;
  assert.equal(BigInt(later.number), BigInt(nextCounter));
  const laterHistory = await stored(f, s.company.id, historyTables);
  const retry = await f.owner.ok<ResetResult>(
    "POST",
    s.base + "/transaction-reset",
    input,
  );
  assert.equal(retry.replayed, true);
  assert.deepEqual(await stored(f, s.company.id, historyTables), laterHistory);
  assert.equal(
    (
      await f.owner.request("POST", s.base + "/transaction-reset", {
        ...input,
        snapshotHash: "0".repeat(64),
      })
    ).status,
    409,
  );
  assert.deepEqual(await stored(f, s.company.id, historyTables), laterHistory);
  for (const statement of [
    "DELETE FROM invoices WHERE company_id=$1",
    "UPDATE invoices SET description='tamper' WHERE company_id=$1",
    "DELETE FROM invoice_lines WHERE company_id=$1",
    "DELETE FROM stock_movements WHERE company_id=$1",
    "DELETE FROM financial_document_lines WHERE company_id=$1",
    "DELETE FROM financial_documents WHERE company_id=$1",
    "DELETE FROM company_transaction_resets WHERE company_id=$1",
  ])
    await assert.rejects(
      f.pool.query(statement, [s.company.id]),
      /immutable|cannot.*deleted|delete/i,
    );
});

async function ownEmployee(f: Fixture, s: Setup) {
  return (
    await f.owner.ok<{ employee: Employee }>(
      "POST",
      s.base + "/employees",
      {
        userId: f.user.id,
        name: "Owner employee",
        phone: "",
        role: "employee",
        active: true,
        permissions: [],
      },
      201,
    )
  ).employee;
}

async function enableTask(f: Fixture, s: Setup, code: string, points: string) {
  const task = (
    await f.owner.ok<{ tasks: RewardTask[] }>("GET", s.base + "/reward-tasks")
  ).tasks.find((row) => row.code === code)!;
  await f.owner.ok("PUT", s.base + "/reward-tasks/" + code, {
    points,
    repeatRule: task.repeatRule,
    enabled: true,
    roleIds: [],
    pageKey: task.pageKey,
    revision: task.revision,
    ...(code === "PAGE_VISIT"
      ? { pageKey: "company.items", repeatRule: "daily", dailyLimit: null }
      : {}),
  });
}

test("transaction reset removes invoice and voucher rewards while preserving unrelated wallet points", async (t) => {
  const f = await fixture(t),
    s = await setup(f, "Reward cleanup pharmacy");
  const employee = await ownEmployee(f, s);
  await f.owner.ok("POST", s.base + "/wallet/awards", {
    employeeId: employee.id,
    points: "20",
    reason: "Unrelated manual reward",
    idempotencyKey: randomUUID(),
  });
  await enableTask(f, s, "PAGE_VISIT", "2");
  await f.owner.ok("POST", s.base + "/reward-events/page-visit", {
    pageKey: "company.items",
    idempotencyKey: randomUUID(),
  });
  const preserved = (await stored(f, s.company.id, ["employee_wallet_entries"]))
    .employee_wallet_entries;
  await enableTask(f, s, "PURCHASE_SAVED", "5");
  await enableTask(f, s, "RECEIPT_PRINT", "3");
  await s.invoice();
  const receipt = await s.document();
  await f.owner.ok(
    "POST",
    `${s.base}/financial-documents/${receipt.id}/print-request`,
    {},
  );
  const preview = await s.preview();
  assert.equal(preview.counts.invoiceWalletRewards, 1);
  assert.equal(preview.counts.voucherWalletRewards, 1);
  assert.equal(preview.counts.linkedWalletEntries, 2);
  assert.deepEqual(preview.walletAdjustments, [
    { employeeId: employee.id, pointsToRemove: "8" },
  ]);
  assert.deepEqual(preview.blockers, []);
  const result = await f.owner.ok<ResetResult>(
    "POST",
    s.base + "/transaction-reset",
    payload(preview),
  );
  assert.equal(result.deleted.linkedWalletEntries, 2);
  assert.deepEqual(
    (await stored(f, s.company.id, ["employee_wallet_entries"]))
      .employee_wallet_entries,
    preserved,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT points::text FROM employee_wallets WHERE company_id=$1 AND employee_id=$2",
        [s.company.id, employee.id],
      )
    ).rows[0]!.points,
    "22",
  );
  for (const rows of Object.values(
    await stored(f, s.company.id, historyTables),
  ))
    assert.deepEqual(rows, []);
  await assert.rejects(
    f.pool.query("DELETE FROM employee_wallet_entries WHERE company_id=$1", [
      s.company.id,
    ]),
    /immutable/i,
  );
  await assert.rejects(
    f.pool.query("UPDATE employee_wallets SET points=0 WHERE company_id=$1", [
      s.company.id,
    ]),
    /immutable|only|ledger|balance/i,
  );
});

test("transaction reset removes an already reversed document reward with zero net wallet change", async (t) => {
  const f = await fixture(t),
    s = await setup(f, "Reversed reward pharmacy");
  const employee = await ownEmployee(f, s);
  await f.owner.ok("POST", s.base + "/wallet/awards", {
    employeeId: employee.id,
    points: "10",
    reason: "Unrelated retained reward",
    idempotencyKey: randomUUID(),
  });
  const preserved = (await stored(f, s.company.id, ["employee_wallet_entries"]))
    .employee_wallet_entries;
  await enableTask(f, s, "PURCHASE_SAVED", "5");
  await s.invoice();
  const source = (
    await f.pool.query(
      "SELECT id FROM employee_wallet_entries WHERE company_id=$1 AND invoice_id IS NOT NULL",
      [s.company.id],
    )
  ).rows[0]!.id;
  await f.owner.ok("POST", s.base + "/wallet/reversals", {
    entryId: source,
    reason: "Exact reward reversal",
    idempotencyKey: randomUUID(),
  });
  const preview = await s.preview();
  assert.equal(preview.counts.linkedWalletEntries, 2);
  assert.deepEqual(preview.blockers, []);
  assert.deepEqual(preview.walletAdjustments, [
    { employeeId: employee.id, pointsToRemove: "0" },
  ]);
  await f.owner.ok("POST", s.base + "/transaction-reset", payload(preview));
  assert.deepEqual(
    (await stored(f, s.company.id, ["employee_wallet_entries"]))
      .employee_wallet_entries,
    preserved,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT points::text FROM employee_wallets WHERE company_id=$1 AND employee_id=$2",
        [s.company.id, employee.id],
      )
    ).rows[0]!.points,
    "10",
  );
});

async function configureConversion(
  f: Fixture,
  s: Setup,
  approvalMode: "direct" | "approval",
) {
  const expense = (
    await f.owner.ok<{ account: Account }>(
      "POST",
      s.base + "/accounts",
      {
        code: "0000000003",
        name: "Reset reward expense",
        parentId: null,
        kind: "posting",
        category: "expense",
        normalSide: "debit",
        cashOrBank: false,
      },
      201,
    )
  ).account;
  const initial = (
    await f.owner.ok<{ policy: WalletPolicy }>(
      "GET",
      s.base + "/wallet-settings",
    )
  ).policy;
  await f.owner.ok("PUT", s.base + "/wallet-settings", {
    pointValue: "1",
    currencyId: s.currency.id,
    expenseAccountId: expense.id,
    approvalMode,
    revision: initial.revision,
  });
  const quote = (
    await f.owner.ok<{ preview: WalletConversionPreview }>(
      "GET",
      s.base + "/wallet/conversion-preview",
    )
  ).preview;
  assert(quote.amount && quote.policyRevision && quote.accountRevision);
  return {
    employeeId: quote.employeeId,
    idempotencyKey: randomUUID(),
    expectedPoints: quote.points,
    expectedAmount: quote.amount,
    policyRevision: quote.policyRevision,
    accountRevision: quote.accountRevision,
  };
}

test("transaction reset refuses reward removal that would consume reserved wallet points", async (t) => {
  const f = await fixture(t),
    s = await setup(f, "Reserved reward pharmacy");
  const employee = await ownEmployee(f, s);
  await f.owner.ok("POST", s.base + "/wallet/awards", {
    employeeId: employee.id,
    points: "10",
    reason: "Unrelated retained reward",
    idempotencyKey: randomUUID(),
  });
  await enableTask(f, s, "PURCHASE_SAVED", "5");
  await s.invoice();
  const input = await configureConversion(f, s, "approval");
  assert.equal(input.expectedPoints, "15");
  await f.owner.ok("POST", s.base + "/wallet-conversions", input);
  const preview = await s.preview();
  assert.equal(
    preview.counts.walletConversions,
    0,
    "Pending conversion has no financial document yet",
  );
  assert(preview.blockers.length > 0);
  const tables = [
    ...historyTables,
    "wallet_conversions",
    "employee_wallet_entries",
    "employee_wallets",
  ];
  const before = await stored(f, s.company.id, tables);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        s.base + "/transaction-reset",
        payload(preview),
      )
    ).status,
    409,
  );
  assert.deepEqual(await stored(f, s.company.id, tables), before);
});

test("transaction reset refuses posted wallet conversions and preserves money and points", async (t) => {
  const f = await fixture(t),
    s = await setup(f, "Conversion blocker pharmacy");
  const employee = await ownEmployee(f, s);
  await f.owner.ok("POST", s.base + "/wallet/awards", {
    employeeId: employee.id,
    points: "10",
    reason: "Disposable conversion setup",
    idempotencyKey: randomUUID(),
  });
  const binding = (
    await f.owner.ok<{ binding: EmployeeWalletAccount }>(
      "GET",
      `${s.base}/wallet-settings/employee-accounts/${employee.id}`,
    )
  ).binding;
  assert(binding.account);
  await f.owner.ok(
    "POST",
    s.base + "/wallet-conversions",
    await configureConversion(f, s, "direct"),
  );
  const preview = await s.preview();
  assert.equal(preview.counts.walletConversions, 1);
  assert(preview.blockers.length > 0);
  const tables = [
    ...historyTables,
    "wallet_conversions",
    "employee_wallet_entries",
    "employee_wallets",
  ];
  const before = await stored(f, s.company.id, tables);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        s.base + "/transaction-reset",
        payload(preview),
      )
    ).status,
    409,
  );
  assert.deepEqual(await stored(f, s.company.id, tables), before);
});

const protectedOperationalTables = [
  "employee_clearance_earnings",
  "employee_clearance_return_reviews",
  "employee_cashbox_operations",
  "employee_pouch_receipts",
  "employee_electronic_receipts",
  "employee_wallet_entries",
  "employee_wallets",
  "account_statistics",
  "company_transaction_resets",
  "audit_events",
] as const;

async function assertProtectedReset(f: Fixture, s: Setup, preview: Preview) {
  const tables = [...historyTables, ...protectedOperationalTables];
  const before = await stored(f, s.company.id, tables);
  assert(preview.blockers.length > 0);
  const denied = await f.owner.request<{ error: { message: string } }>(
    "POST",
    s.base + "/transaction-reset",
    payload(preview),
  );
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  // The execution service independently rechecks, rather than depending on a
  // particular HTTP caller having read the preview's blockers correctly.
  await assert.rejects(
    transaction(f.pool, async (client) => {
      await client.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [
        s.company.id,
      ]);
      await deleteCompanyTransactions(client, s.company.id);
    }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 409 &&
      error.code === "transaction_reset_blocked",
  );
  assert.deepEqual(await stored(f, s.company.id, tables), before);
}

test("transaction reset blocks immutable cashbox and receipt history and confirms accepted UUIDs safely", async (t) => {
  const f = await fixture(t),
    s = await setup(f, "Protected till operation history");
  const employee = await ownEmployee(f, s);
  await f.owner.ok("POST", `${s.base}/employees/${employee.id}/accounts`, {
    createSalesCashbox: true,
  });
  const original = payload(await s.preview());
  await f.owner.ok<ResetResult>(
    "POST",
    s.base + "/transaction-reset",
    original,
  );

  const pouch = await f.owner.ok<{ operationId: number }>(
    "POST",
    s.base + "/sales/cashbox-operations",
    {
      kind: "pouch",
      amount: "10",
      notes: "Real till transfer",
      idempotencyKey: randomUUID(),
    },
    201,
  );
  const afterTransfer = await s.preview();
  assert.equal(afterTransfer.counts.cashboxOperations, 1);
  assert.equal(afterTransfer.counts.pouchReceipts, 0);
  assert.equal(afterTransfer.counts.electronicReceipts, 0);
  assert.equal(afterTransfer.blockers.length, 1);
  await assertProtectedReset(f, s, afterTransfer);

  await f.owner.ok(
    "POST",
    s.base + "/pouch-receipts",
    {
      mode: "exact",
      sourceOperationId: pouch.operationId,
      notes: "Receive actual pouch source",
      idempotencyKey: randomUUID(),
    },
    201,
  );
  await f.owner.ok("PUT", s.base + "/account-links/electronicWallet", {
    accountId: s.counterparty.id,
  });
  const electronic = await f.owner.ok<{ operationId: number }>(
    "POST",
    s.base + "/sales/cashbox-operations",
    {
      kind: "electronic",
      amount: "5",
      notes: "Real wallet transfer",
      idempotencyKey: randomUUID(),
    },
    201,
  );
  await f.owner.ok(
    "POST",
    s.base + "/electronic-receipts",
    {
      mode: "exact",
      sourceOperationId: electronic.operationId,
      notes: "Receive actual electronic source",
      idempotencyKey: randomUUID(),
    },
    201,
  );
  const received = await s.preview();
  assert.equal(received.counts.cashboxOperations, 2);
  assert.equal(received.counts.pouchReceipts, 1);
  assert.equal(received.counts.electronicReceipts, 1);
  assert.equal(received.blockers.length, 3);
  assert.notEqual(received.snapshotHash, afterTransfer.snapshotHash);
  await assertProtectedReset(f, s, received);

  const preserved = await stored(f, s.company.id, [
    ...historyTables,
    ...protectedOperationalTables,
  ]);
  const retry = await f.owner.ok<ResetResult>(
    "POST",
    s.base + "/transaction-reset",
    original,
  );
  assert.equal(
    retry.replayed,
    true,
    "An accepted old reset confirms its receipt before considering later blockers",
  );
  assert.deepEqual(
    await stored(f, s.company.id, [
      ...historyTables,
      ...protectedOperationalTables,
    ]),
    preserved,
  );

  const other = await setup(f, "Independent company reset remains allowed");
  await other.document();
  const otherPreview = await other.preview();
  assert.deepEqual(
    otherPreview.blockers,
    [],
    "Protected rows never block another company",
  );
  await f.owner.ok(
    "POST",
    other.base + "/transaction-reset",
    payload(otherPreview),
  );
  assert.deepEqual(
    await stored(f, s.company.id, [
      ...historyTables,
      ...protectedOperationalTables,
    ]),
    preserved,
  );
});

async function enableClearance(f: Fixture, s: Setup) {
  await f.owner.ok("PATCH", `${s.base}/items/${s.item.id}`, {
    name: s.item.name,
    currencyId: s.currency.id,
    revision: s.item.revision,
    unit1Name: "باكت",
    salePrice1: "20",
    salePrice2: "20",
    salePrice3: "20",
    purchasePrice: "10",
    hasExpiry: false,
    commissionRate: "10",
    clearanceFrom: "2026-10-01",
    clearanceTo: "2026-10-31",
  });
}

test("transaction reset blocks clearance earnings and review-only history without changing wallet credits", async (t) => {
  const f = await fixture(t),
    earnings = await setup(f, "Protected clearance earnings");
  await ownEmployee(f, earnings);
  await enableClearance(f, earnings);
  await earnings.invoice();
  await earnings.invoice("sale", "2");
  const earningPreview = await earnings.preview();
  assert.equal(earningPreview.counts.clearanceEarnings, 1);
  assert.equal(earningPreview.counts.clearanceReturnReviews, 0);
  assert.equal(earningPreview.blockers.length, 1);
  const credits = (
    await f.pool.query(
      "SELECT points::text FROM employee_wallet_entries WHERE company_id=$1 AND kind='clearance'",
      [earnings.company.id],
    )
  ).rows;
  assert.equal(credits.length, 1);
  assert(BigInt(credits[0]!.points) > 0n);
  assert.deepEqual(
    earningPreview.walletAdjustments,
    [],
    "Clearance credits are never reinterpreted as removable automatic rewards",
  );
  await assertProtectedReset(f, earnings, earningPreview);

  const reviews = await setup(f, "Protected clearance return review only");
  await enableClearance(f, reviews);
  await reviews.invoice();
  // The original saver has no employee record, so no earning or wallet credit
  // exists. A linked return still creates an independently protected review.
  const original = await reviews.invoice("sale", "2");
  await ownEmployee(f, reviews);
  await f.owner.ok(
    "POST",
    reviews.base + "/invoices",
    {
      idempotencyKey: randomUUID(),
      kind: "sale",
      documentDate: "2026-10-12",
      currencyId: reviews.currency.id,
      branchId: reviews.branch.id,
      locationId: reviews.location.id,
      counterpartyAccountId: reviews.counterparty.id,
      lines: [
        {
          itemId: reviews.item.id,
          unit: 1,
          quantity: "-1",
          originalLineId: original.lines[0]!.id,
        },
      ],
    },
    201,
  );
  const beforeReview = await reviews.preview();
  assert.equal(beforeReview.counts.clearanceEarnings, 0);
  assert.equal(beforeReview.counts.clearanceReturnReviews, 1);
  assert.equal(beforeReview.blockers.length, 1);
  await assertProtectedReset(f, reviews, beforeReview);
  const reviewId = (
    await f.pool.query(
      "SELECT id FROM employee_clearance_return_reviews WHERE company_id=$1",
      [reviews.company.id],
    )
  ).rows[0]!.id;
  await f.owner.ok(
    "POST",
    `${reviews.base}/wallet/clearance-returns/${reviewId}/review`,
    { note: "Reviewed without deleting entitlement or history" },
  );
  const afterReview = await reviews.preview();
  assert.deepEqual(afterReview.counts, beforeReview.counts);
  assert.notEqual(
    afterReview.snapshotHash,
    beforeReview.snapshotHash,
    "A review content change invalidates the fingerprint even with unchanged row counts and journals",
  );
  await assertProtectedReset(f, reviews, afterReview);
});
