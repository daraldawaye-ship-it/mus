import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Account,
  Branch,
  Company,
  CompanyCurrency,
  Employee,
  Item,
  Location,
  Page,
  RewardTask,
  SessionResponse,
} from "../packages/contracts/src/index.ts";
import type {
  Invoice,
  InvoiceInput,
} from "../packages/contracts/src/commerce.ts";
import type { InventorySettings } from "../packages/contracts/src/inventory.ts";

// Never use DATABASE_URL: the import checks run only on the local disposable DB.
const databaseUrl = DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "Historical-import-disposable-tests-2026";

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

async function fixture(t: TestContext) {
  const schema = `import_test_${randomUUID().replaceAll("-", "")}`;
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
    name: "Admin",
    displayName: "Admin",
    email: "owner@import.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  async function company(name = "دار الدواء اختبار") {
    return (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        { name, phone: "", address: "" },
        201,
      )
    ).company;
  }
  async function member(companyId: number) {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>(
      "POST",
      "/auth/register",
      {
        name: "Importer staff",
        displayName: "Importer staff",
        email: `${randomUUID()}@import.test`,
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
          name: "Importer staff",
          phone: "",
          role: "employee",
          active: true,
          permissions: ["commerce.manage", "finance.manage", "finance.post"],
        },
        201,
      )
    ).employee;
    return { client, user: session.user, employee };
  }
  return {
    pool: runtime.pool,
    owner,
    user,
    company,
    member,
    anonymous: new Client(baseUrl),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setup(f: Fixture) {
  const company = await f.company();
  const base = `/companies/${company.id}`;
  const currency = (
    await f.owner.ok<Page<CompanyCurrency>>("GET", base + "/currencies")
  ).items.find((v) => v.code === "YER")!;
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
          accountChoice: cashOrBank ? "cashbox" : "customer",
        },
        201,
      )
    ).account;
  }
  const cash = await account("0000000001", "Import cash", true);
  const counterparty = await account(
    "0000000002",
    "Import customer supplier",
    false,
  );
  const settings = (
    await f.owner.ok<{ settings: InventorySettings }>(
      "GET",
      base + "/inventory-settings",
    )
  ).settings;
  await f.owner.ok("PUT", base + "/inventory-settings", {
    inventoryAccountId: settings.inventoryAccountId,
    salesAccountId: settings.salesAccountId,
    cogsAccountId: settings.cogsAccountId,
    surplusAccountId: settings.surplusAccountId,
    shortageAccountId: settings.shortageAccountId,
    costingMethod: "weighted_average",
    allowNegative: true,
    revision: settings.revision,
  });
  async function item(expiry = true, extra: Record<string, unknown> = {}) {
    return (
      await f.owner.ok<{ item: Item }>(
        "POST",
        base + "/items",
        {
          idempotencyKey: randomUUID(),
          name: "Historical item",
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
          hasExpiry: expiry,
          currencyId: currency.id,
          ...extra,
        },
        201,
      )
    ).item;
  }
  const invoice = (
    itemId: number,
    overrides: Partial<InvoiceInput> = {},
  ): InvoiceInput => ({
    idempotencyKey: randomUUID(),
    kind: "purchase",
    documentDate: "2026-10-15",
    currencyId: currency.id,
    branchId: branch.id,
    locationId: location.id,
    counterpartyAccountId: counterparty.id,
    lines: [
      { itemId, unit: 1, quantity: "10", unitPrice: "7", expiryDate: null },
    ],
    ...overrides,
  });
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
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

type Imported = {
  type: "invoice" | "voucher";
  sourceId: string;
  id: number;
  number: string;
};
type ImportResult = {
  imported: Imported[];
  existing: Imported[];
  failed: { type: string; sourceId: string; code: string; message: string }[];
  replayed: boolean;
};
type ImportSummary = {
  invoices: { kind: string; count: number; total: string; lines: number }[];
  vouchers: { kind: string; count: number; total: string }[];
  sources: {
    count: number;
    source_rows: number;
    first_source_date: string | null;
    last_source_date: string | null;
  };
  ledger: {
    documents: number;
    debit: string;
    credit: string;
    unbalanced: number;
  };
};
function source(
  type: "invoice" | "voucher",
  payload: unknown,
  sourceId = randomUUID(),
) {
  return {
    type,
    sourceId,
    sourceDocumentNumber: `OLD-${sourceId}`,
    sourceCreatedAt: "2026-09-30 23:30:00",
    sourceCreators: ["Legacy operator"],
    sourceMovementIds: [`movement-${sourceId}`],
    sourceRows: [
      { legacyId: sourceId, amountAlreadyDiscounted: "true" },
    ] as Record<string, string>[],
    payload,
  };
}
function batch(documents: ReturnType<typeof source>[]) {
  return {
    idempotencyKey: randomUUID(),
    sourceSystem: "disposable-source-v1",
    postingDate: "2026-10-15",
    documents,
  };
}
function voucher(
  s: Setup,
  amount = "10",
  kind: "receipt" | "payment" = "receipt",
) {
  return {
    idempotencyKey: randomUUID(),
    kind,
    documentDate: "2026-10-15",
    currencyId: s.currency.id,
    branchId: s.branch.id,
    cashAccountId: s.cash.id,
    description: "Historical voucher",
    lines: [
      {
        accountId: s.cash.id,
        debit: kind === "receipt" ? amount : "0",
        credit: kind === "payment" ? amount : "0",
      },
      {
        accountId: s.counterparty.id,
        debit: kind === "payment" ? amount : "0",
        credit: kind === "receipt" ? amount : "0",
      },
    ],
  };
}
const importPath = (s: Setup) => s.base + "/transaction-import/batch";
type SourceDatePreview = {
  snapshotHash: string;
  counts: { table_name: string; total: number; pending: number }[];
};
async function importBatch(
  f: Fixture,
  s: Setup,
  body: ReturnType<typeof batch>,
) {
  return f.owner.ok<ImportResult>("POST", importPath(s), body);
}
async function invoiceDetail(f: Fixture, s: Setup, id: number) {
  return (
    await f.owner.ok<{ invoice: Invoice }>("GET", `${s.base}/invoices/${id}`)
  ).invoice;
}

test("historical invoices preserve net prices and unknown expiry without changing ordinary posting or granting rewards", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  await f.owner.ok(
    "POST",
    s.base + "/employees",
    {
      userId: f.user.id,
      name: "Admin employee",
      phone: "",
      role: "employee",
      active: true,
      permissions: [],
    },
    201,
  );
  const tasks = (
    await f.owner.ok<{ tasks: RewardTask[] }>("GET", s.base + "/reward-tasks")
  ).tasks;
  for (const code of ["SALE_SAVED", "PURCHASE_SAVED"]) {
    const task = tasks.find((v) => v.code === code)!;
    await f.owner.ok("PUT", s.base + "/reward-tasks/" + code, {
      points: "5",
      repeatRule: task.repeatRule,
      enabled: true,
      roleIds: [],
      pageKey: task.pageKey,
      revision: task.revision,
    });
  }
  const item = await s.item(true, {
    commissionRate: "5",
    clearanceFrom: "2026-10-01",
    clearanceTo: "2026-10-31",
  });
  const purchased = await importBatch(
    f,
    s,
    batch([source("invoice", s.invoice(item.id))]),
  );
  assert.equal(purchased.failed.length, 0);
  const purchase = await invoiceDetail(f, s, purchased.imported[0]!.id);
  assert.equal(purchase.createdBy, f.user.id);
  assert.equal(purchase.total, "70");
  assert.equal(purchase.lines[0]!.expiryDate, null);
  const sold = await importBatch(
    f,
    s,
    batch([
      source(
        "invoice",
        s.invoice(item.id, {
          kind: "sale",
          lines: [
            {
              itemId: item.id,
              unit: 1,
              quantity: "2",
              unitPrice: "13",
              expiryDate: null,
            },
          ],
        }),
      ),
    ]),
  );
  assert.equal(sold.failed.length, 0);
  const sale = await invoiceDetail(f, s, sold.imported[0]!.id);
  assert.equal(sale.total, "26");
  assert.equal(sale.lines[0]!.unitPrice, "13");
  assert.equal(sale.lines[0]!.commissionAmount, "0");
  assert.equal(sale.lines[0]!.commissionRate, "0");
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM employee_wallet_entries WHERE company_id=$1 AND invoice_id IS NOT NULL",
        [s.company.id],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (await f.owner.request("POST", s.base + "/invoices", s.invoice(item.id)))
      .status,
    409,
  );
  assert.equal(
    (
      await f.owner.request(
        "POST",
        s.base + "/invoices",
        s.invoice(item.id, {
          kind: "sale",
          lines: [{ itemId: item.id, unit: 1, quantity: "1", unitPrice: "13" }],
        }),
      )
    ).status,
    409,
  );
  const ordinary = (
    await f.owner.ok<{ invoice: Invoice }>(
      "POST",
      s.base + "/invoices",
      s.invoice(item.id, {
        kind: "sale",
        lines: [{ itemId: item.id, unit: 1, quantity: "1" }],
      }),
      201,
    )
  ).invoice;
  assert.equal(ordinary.lines[0]!.unitPrice, "20");
  assert.equal(ordinary.lines[0]!.commissionAmount, "1");
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM employee_wallet_entries WHERE company_id=$1 AND invoice_id=$2 AND kind='automatic'",
        [s.company.id, ordinary.id],
      )
    ).rows[0].count,
    1,
  );
  const stock = await f.pool.query(
    "SELECT sum(quantity_smallest)::text AS quantity FROM stock_balances WHERE company_id=$1 AND item_id=$2",
    [s.company.id, item.id],
  );
  assert.equal(stock.rows[0].quantity, "7");
  const balance = await f.pool.query(
    "SELECT sum(base_debit)::text AS debit,sum(base_credit)::text AS credit FROM financial_document_lines WHERE company_id=$1",
    [s.company.id],
  );
  assert.equal(balance.rows[0].debit, balance.rows[0].credit);
});

test("historical batch receipts replay exactly and preserve old source metadata with scoped identities", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const record = source("voucher", voucher(s));
  const input = batch([record]);
  const first = await importBatch(f, s, input);
  assert.equal(first.imported.length, 1);
  assert.equal(first.failed.length, 0);
  const replay = await importBatch(f, s, input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.imported, first.imported);
  assert.equal(
    (
      await f.owner.request("POST", importPath(s), {
        ...input,
        sourceSystem: "different-valid-source",
      })
    ).status,
    409,
  );
  const duplicate = await importBatch(f, s, batch([record]));
  assert.equal(duplicate.imported.length, 0);
  assert.equal(duplicate.existing.length, 1);
  assert.equal(duplicate.existing[0]!.id, first.imported[0]!.id);
  const changed = structuredClone(record);
  changed.sourceCreatedAt = "2026-10-01 00:00:00";
  const conflict = await importBatch(f, s, batch([changed]));
  assert.equal(conflict.imported.length, 0);
  assert.equal(conflict.failed.length, 1);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM financial_documents WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0].count,
    1,
  );
  const mapping = await f.pool.query(
    "SELECT * FROM transaction_source_imports WHERE company_id=$1",
    [s.company.id],
  );
  assert.equal(mapping.rows.length, 1);
  assert.match(JSON.stringify(mapping.rows[0]), /2026-09-30 23:30:00/);
  assert.match(JSON.stringify(mapping.rows[0]), /Legacy operator/);
});

test("historical batches roll back every failed document to its savepoint while committing balanced neighboring vouchers", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const item = await s.item(false);
  await f.pool.query(
    "CREATE FUNCTION reject_import_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.unit_price=999 THEN RAISE EXCEPTION 'Disposable import rollback check' USING ERRCODE='23514'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER reject_import_line BEFORE INSERT ON invoice_lines FOR EACH ROW EXECUTE FUNCTION reject_import_line()",
  );
  const bad = s.invoice(item.id, {
    lines: [
      { itemId: item.id, unit: 1, quantity: "1", unitPrice: "7" },
      { itemId: item.id, unit: 1, quantity: "1", unitPrice: "999" },
    ],
  });
  const input = batch([
    source("voucher", voucher(s)),
    source("invoice", bad),
    source("voucher", voucher(s, "4", "payment")),
  ]);
  const result = await importBatch(f, s, input);
  assert.equal(result.imported.length, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.sourceId, input.documents[1]!.sourceId);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM invoices WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM stock_movements WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0].count,
    0,
  );
  const docs = await f.pool.query(
    "SELECT status,total_base_debit::text AS debit,total_base_credit::text AS credit FROM financial_documents WHERE company_id=$1",
    [s.company.id],
  );
  assert.equal(docs.rows.length, 2);
  for (const doc of docs.rows) {
    assert.equal(doc.status, "posted");
    assert.equal(doc.debit, doc.credit);
  }
  const replay = await importBatch(f, s, input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.failed, result.failed);
});

test("historical invoice imports retain 107 source lines as one posted invoice", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item(false);
  const result = await importBatch(
    f,
    s,
    batch([
      source(
        "invoice",
        s.invoice(item.id, {
          lines: Array.from({ length: 107 }, () => ({
            itemId: item.id,
            unit: 1 as const,
            quantity: "1",
            unitPrice: "1",
          })),
        }),
      ),
    ]),
  );
  assert.equal(result.failed.length, 0);
  assert.equal(result.imported.length, 1);
  const invoice = await invoiceDetail(f, s, result.imported[0]!.id);
  assert.equal(invoice.lines.length, 107);
  assert.equal(invoice.total, "107");
  assert.equal(
    (
      await f.owner.request(
        "POST",
        s.base + "/invoices",
        s.invoice(item.id, {
          lines: Array.from({ length: 107 }, () => ({
            itemId: item.id,
            unit: 1 as const,
            quantity: "1",
            unitPrice: "1",
          })),
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM invoices WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0].count,
    1,
  );
});

test("historical import authorization excludes members and general managers and enforces page flags without breaking accepted retries", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const input = batch([source("voucher", voucher(s))]);
  assert.equal(
    (await f.anonymous.request("POST", importPath(s), input)).status,
    401,
  );
  const member = await f.member(s.company.id);
  assert.equal(
    (await member.client.request("POST", importPath(s), input)).status,
    403,
  );
  await f.owner.ok(
    "PATCH",
    `${s.base}/employees/${member.employee.id}/manager`,
    { isGeneralManager: true },
  );
  assert.equal(
    (await member.client.request("POST", importPath(s), input)).status,
    403,
  );
  const accepted = await importBatch(f, s, input);
  await f.pool.query("UPDATE users SET suspended=true WHERE id=$1", [
    f.user.id,
  ]);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        importPath(s),
        batch([source("voucher", voucher(s))]),
      )
    ).status,
    403,
  );
  await f.pool.query("UPDATE users SET suspended=false WHERE id=$1", [
    f.user.id,
  ]);
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
    (
      await f.owner.request(
        "POST",
        importPath(s),
        batch([source("voucher", voucher(s))]),
      )
    ).status,
    403,
  );
  const replay = await importBatch(f, s, input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.imported, accepted.imported);
});

test("historical imports reject cross-company references and mismatched posting dates without writing partial history", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await f.company("Another isolated pharmacy");
  const input = batch([source("voucher", voucher(s))]);
  const cross = await f.owner.ok<ImportResult>(
    "POST",
    `/companies/${other.id}/transaction-import/batch`,
    input,
  );
  assert.equal(cross.imported.length, 0);
  assert.equal(cross.failed.length, 1);
  const wrongDate = voucher(s);
  wrongDate.documentDate = "2026-09-30";
  assert.equal(
    (
      await f.owner.request(
        "POST",
        importPath(s),
        batch([source("voucher", wrongDate)]),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM financial_documents",
      )
    ).rows[0].count,
    0,
  );
});

test("an explicit transaction reset clears imported provenance but retains batch receipts so delayed retries cannot recreate history", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item(false);
  const input = batch([
    source("voucher", voucher(s)),
    source("invoice", s.invoice(item.id)),
  ]);
  const imported = await importBatch(f, s, input);
  assert.equal(imported.imported.length, 2);
  assert.equal(imported.failed.length, 0);
  const summaryPath =
    s.base +
    "/transaction-import/summary?sourceSystem=" +
    encodeURIComponent(input.sourceSystem);
  const summary = await f.owner.ok<ImportSummary>("GET", summaryPath);
  assert.equal(summary.invoices.length, 1);
  assert.deepEqual(
    { ...summary.invoices[0], total: undefined },
    { kind: "purchase", count: 1, lines: 1, total: undefined },
  );
  assert.match(summary.invoices[0]!.total, /^70(?:\.0+)?$/);
  assert.equal(summary.vouchers.length, 1);
  assert.equal(summary.vouchers[0]!.kind, "receipt");
  assert.equal(summary.vouchers[0]!.count, 1);
  assert.match(summary.vouchers[0]!.total, /^10(?:\.0+)?$/);
  assert.deepEqual(summary.sources, {
    count: 2,
    source_rows: 2,
    first_source_date: "2026-09-30 23:30:00",
    last_source_date: "2026-09-30 23:30:00",
  });
  assert.equal(summary.ledger.documents, 2);
  assert.match(summary.ledger.debit, /^80(?:\.0+)?$/);
  assert.equal(summary.ledger.debit, summary.ledger.credit);
  assert.equal(summary.ledger.unbalanced, 0);
  const member = await f.member(s.company.id);
  assert.equal((await member.client.request("GET", summaryPath)).status, 403);
  const other = await f.company("Isolated summary pharmacy");
  const emptySummary = await f.owner.ok<ImportSummary>(
    "GET",
    `/companies/${other.id}/transaction-import/summary?sourceSystem=${encodeURIComponent(input.sourceSystem)}`,
  );
  assert.deepEqual(emptySummary.invoices, []);
  assert.deepEqual(emptySummary.vouchers, []);
  assert.equal(emptySummary.sources.count, 0);
  assert.equal(emptySummary.sources.source_rows, 0);
  assert.equal(emptySummary.ledger.documents, 0);
  assert.equal(emptySummary.ledger.unbalanced, 0);
  const preview = await f.owner.ok<{
    companyName: string;
    snapshotHash: string;
    counts: Record<string, number>;
  }>("GET", s.base + "/transaction-reset");
  assert.equal(preview.counts.sourceImports, 2);
  await f.owner.ok("POST", s.base + "/transaction-reset", {
    idempotencyKey: randomUUID(),
    snapshotHash: preview.snapshotHash,
    confirmationCompanyName: preview.companyName,
    deleteAllTransactions: true,
  });
  for (const table of [
    "invoices",
    "financial_documents",
    "stock_movements",
    "transaction_source_imports",
  ]) {
    assert.equal(
      (
        await f.pool.query(
          `SELECT count(*)::integer AS count FROM ${table} WHERE company_id=$1`,
          [s.company.id],
        )
      ).rows[0].count,
      0,
      table,
    );
  }
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM transaction_import_batches WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0].count,
    1,
  );
  const delayed = await importBatch(f, s, input);
  assert.equal(delayed.replayed, true);
  assert.deepEqual(delayed.imported, imported.imported);
  const clearedSummary = await f.owner.ok<ImportSummary>("GET", summaryPath);
  assert.deepEqual(clearedSummary.invoices, []);
  assert.deepEqual(clearedSummary.vouchers, []);
  assert.equal(clearedSummary.sources.count, 0);
  assert.equal(clearedSummary.ledger.documents, 0);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM transaction_source_imports WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM financial_documents WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM items WHERE company_id=$1 AND id=$2",
        [s.company.id, item.id],
      )
    ).rows[0].count,
    1,
  );
});

test("historical imports preserve explicit expense counterparties and purchase-return suppliers while ordinary invoices retain account restrictions", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item(false);
  const expense = (
    await f.owner.ok<{ account: Account }>(
      "POST",
      s.base + "/accounts",
      {
        code: "0000000003",
        name: "Explicit legacy expense",
        parentId: null,
        kind: "posting",
        category: "expense",
        normalSide: "debit",
        cashOrBank: false,
        accountChoice: "expense",
      },
      201,
    )
  ).account;
  const expenseSale = s.invoice(item.id, {
    kind: "sale",
    counterpartyAccountId: expense.id,
    lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "13" }],
  });
  assert.equal(
    (
      await f.owner.request("POST", s.base + "/invoices", {
        ...expenseSale,
        lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "20" }],
      })
    ).status,
    409,
  );
  const expenseReturn = s.invoice(item.id, {
    counterpartyAccountId: expense.id,
    supplierAccountId: expense.id,
    lines: [{ itemId: item.id, unit: 1, quantity: "-1", unitPrice: "7" }],
  });
  assert.equal(
    (
      await f.owner.request("POST", s.base + "/invoices", {
        ...expenseReturn,
        idempotencyKey: randomUUID(),
        counterpartyAccountId: s.cash.id,
      })
    ).status,
    201,
  );
  const saleSource = source("invoice", expenseSale);
  saleSource.sourceRows = [
    {
      legacyAccountId: "123456",
      originalName: "Explicit legacy expense",
      amountAlreadyDiscounted: "true",
    },
  ];
  const returnSource = source("invoice", expenseReturn);
  returnSource.sourceRows = [
    {
      legacyAccountId: "123456",
      originalSupplier: "123456",
      amountAlreadyDiscounted: "true",
    },
  ];
  const settings = (
    await f.owner.ok<{ settings: InventorySettings }>(
      "GET",
      s.base + "/inventory-settings",
    )
  ).settings;
  const result = await importBatch(
    f,
    s,
    batch([
      source("invoice", s.invoice(item.id)),
      saleSource,
      returnSource,
      source(
        "invoice",
        s.invoice(item.id, {
          ...expenseSale,
          idempotencyKey: randomUUID(),
          counterpartyAccountId: settings.cogsAccountId,
        }),
      ),
    ]),
  );
  assert.equal(result.imported.length, 3);
  assert.equal(
    result.failed.length,
    1,
    "Operational inventory accounts remain prohibited as counterparties",
  );
  const sale = await invoiceDetail(
    f,
    s,
    result.imported.find((v) => v.sourceId === saleSource.sourceId)!.id,
  );
  const returned = await invoiceDetail(
    f,
    s,
    result.imported.find((v) => v.sourceId === returnSource.sourceId)!.id,
  );
  assert.equal(sale.counterpartyAccountId, expense.id);
  assert.equal(sale.total, "26");
  assert.equal(returned.counterpartyAccountId, expense.id);
  assert.equal(returned.supplierAccountId, expense.id);
  assert.equal(returned.total, "-7");
  const provenance = await f.pool.query(
    "SELECT source_metadata FROM transaction_source_imports WHERE company_id=$1 AND source_id=ANY($2::text[]) ORDER BY source_id",
    [s.company.id, [saleSource.sourceId, returnSource.sourceId]],
  );
  assert.equal(provenance.rows.length, 2);
  for (const row of provenance.rows)
    assert.equal(row.source_metadata.sourceRows[0].legacyAccountId, "123456");
  const journals = await f.pool.query(
    "SELECT total_base_debit::text AS debit,total_base_credit::text AS credit FROM financial_documents WHERE company_id=$1",
    [s.company.id],
  );
  assert(journals.rows.length >= 3);
  for (const journal of journals.rows)
    assert.equal(journal.debit, journal.credit);
  const master = (
    await f.owner.ok<{ account: Account }>(
      "GET",
      `${s.base}/accounts/${expense.id}`,
    )
  ).account;
  assert.equal(master.category, "expense");
  assert.equal(master.cashOrBank, false);
});

test("a 100-voucher historical batch posts balanced documents atomically and retries without duplication", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const input = batch(
    Array.from({ length: 100 }, (_, index) =>
      source(
        "voucher",
        voucher(s, "10", index % 2 === 0 ? "receipt" : "payment"),
      ),
    ),
  );
  await f.pool.query(
    "CREATE FUNCTION reject_import_batch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='company.transactions.import' THEN RAISE EXCEPTION 'Disposable batch audit rollback check' USING ERRCODE='23514'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER reject_import_batch_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_import_batch_audit()",
  );
  assert.equal(
    (await f.owner.request("POST", importPath(s), input)).status,
    500,
  );
  for (const table of [
    "financial_documents",
    "financial_document_lines",
    "transaction_source_imports",
    "transaction_import_batches",
  ]) {
    assert.equal(
      (
        await f.pool.query(
          `SELECT count(*)::integer AS count FROM ${table} WHERE company_id=$1`,
          [s.company.id],
        )
      ).rows[0].count,
      0,
      "Failed batch audit must roll back " + table,
    );
  }
  await f.pool.query("DROP TRIGGER reject_import_batch_audit ON audit_events");
  await f.pool.query("DROP FUNCTION reject_import_batch_audit()");
  const accepted = await importBatch(f, s, input);
  assert.equal(accepted.imported.length, 100);
  assert.equal(accepted.existing.length, 0);
  assert.equal(accepted.failed.length, 0);
  const totals = (
    await f.pool.query(
      "SELECT count(*)::integer AS documents,count(*) FILTER(WHERE status='posted')::integer AS posted,sum(total_base_debit)::text AS debit,sum(total_base_credit)::text AS credit,count(*) FILTER(WHERE total_debit<>total_credit OR total_base_debit<>total_base_credit)::integer AS unbalanced FROM financial_documents WHERE company_id=$1",
      [s.company.id],
    )
  ).rows[0];
  assert.equal(totals.documents, 100);
  assert.equal(totals.posted, 100);
  assert.match(totals.debit, /^1000(?:\.0+)?$/);
  assert.equal(totals.debit, totals.credit);
  assert.equal(totals.unbalanced, 0);
  const repeated = await importBatch(f, s, input);
  assert.equal(repeated.replayed, true);
  assert.deepEqual(repeated.imported, accepted.imported);
  for (const table of ["financial_documents", "transaction_source_imports"]) {
    assert.equal(
      (
        await f.pool.query(
          `SELECT count(*)::integer AS count FROM ${table} WHERE company_id=$1`,
          [s.company.id],
        )
      ).rows[0].count,
      100,
      table,
    );
  }
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM transaction_import_batches WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0].count,
    1,
  );
  assert.equal(
    (
      await f.owner.request(
        "POST",
        importPath(s),
        batch([...input.documents, source("voucher", voucher(s))]),
      )
    ).status,
    400,
    "The batch remains bounded at 100 documents",
  );
});

test("source-date correction atomically dates imported invoices, mixed stock movements and every linked journal while preserving ordinary history and derived reports", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item(false);
  const purchase = source("invoice", s.invoice(item.id));
  const sale = source(
    "invoice",
    s.invoice(item.id, {
      kind: "sale",
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "2",
          unitPrice: "9",
          expiryDate: null,
        },
        {
          itemId: item.id,
          unit: 1,
          quantity: "-1",
          unitPrice: "9",
          expiryDate: null,
        },
      ],
    }),
  );
  sale.sourceCreatedAt = "2026-10-01 00:15:00";
  const input = batch([purchase, sale, source("voucher", voucher(s))]);
  const posted = await importBatch(f, s, input);
  assert.equal(posted.failed.length, 0);
  const ordinary = (
    await f.owner.ok<{ invoice: Invoice }>(
      "POST",
      s.base + "/invoices",
      s.invoice(item.id, {
        kind: "sale",
        lines: [{ itemId: item.id, unit: 1, quantity: "1", expiryDate: null }],
      }),
      201,
    )
  ).invoice;
  const other = await setup(f);
  await importBatch(f, other, batch([source("voucher", voucher(other))]));
  const path = s.base + "/transaction-import/source-dates",
    query = "?sourceSystem=disposable-source-v1";
  const preview = await f.owner.ok<SourceDatePreview>("GET", path + query);
  assert.equal(
    preview.counts.find((r) => r.table_name === "invoices")?.pending,
    2,
  );
  const request = {
    idempotencyKey: randomUUID(),
    sourceSystem: input.sourceSystem,
    snapshotHash: preview.snapshotHash,
  };
  await assert.rejects(
    f.pool.query(
      "UPDATE invoices SET document_date=$1 WHERE company_id=$2 AND id=$3",
      ["2026-09-30", s.company.id, posted.imported[0]!.id],
    ),
  );
  const client = await f.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('tijara.source_date_company',$1,true),set_config('tijara.source_date_txid',txid_current()::text,true)",
      [String(s.company.id)],
    );
    await assert.rejects(
      client.query(
        "UPDATE invoices SET document_date=$1 WHERE company_id=$2 AND id=$3",
        ["2026-09-30", s.company.id, posted.imported[0]!.id],
      ),
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  const result = await f.owner.ok<{
    protectedHistoryUnchanged: boolean;
    replayed: boolean;
    counts: SourceDatePreview["counts"];
  }>("POST", path, request);
  assert.equal(result.protectedHistoryUnchanged, true);
  assert.equal(result.replayed, false);
  assert(result.counts.every((r) => r.pending === 0));
  const invoices = (
    await f.pool.query(
      "SELECT id,document_date::text AS date FROM invoices WHERE company_id=$1 ORDER BY id",
      [s.company.id],
    )
  ).rows;
  assert.deepEqual(
    invoices.map((r) => r.date),
    ["2026-09-30", "2026-10-01", "2026-10-15"],
  );
  assert.equal(invoices[2].id, ordinary.id);
  const stock = (
    await f.pool.query(
      "SELECT invoice_id,document_date::text AS date FROM stock_movements WHERE company_id=$1 ORDER BY id",
      [s.company.id],
    )
  ).rows;
  assert.deepEqual(
    stock.map((r) => r.date),
    ["2026-09-30", "2026-10-01", "2026-10-01", "2026-10-15"],
  );
  assert.equal(
    (
      await f.pool.query(
        `SELECT count(*)::int AS n FROM invoices i JOIN financial_documents d ON d.company_id=i.company_id AND d.id IN(i.financial_document_id,i.cost_document_id,i.variance_document_id) WHERE i.company_id=$1 AND d.document_date<>i.document_date`,
        [s.company.id],
      )
    ).rows[0].n,
    0,
  );
  const days = (
    await f.pool.query(
      "SELECT document_date::text AS date,sale_invoices::int,sale_return_invoices::int,purchase_invoices::int FROM item_daily_activity WHERE company_id=$1 AND item_id=$2 ORDER BY document_date",
      [s.company.id, item.id],
    )
  ).rows;
  assert.deepEqual(days, [
    {
      date: "2026-09-30",
      sale_invoices: 0,
      sale_return_invoices: 0,
      purchase_invoices: 1,
    },
    {
      date: "2026-10-01",
      sale_invoices: 1,
      sale_return_invoices: 1,
      purchase_invoices: 0,
    },
    {
      date: "2026-10-15",
      sale_invoices: 1,
      sale_return_invoices: 0,
      purchase_invoices: 0,
    },
  ]);
  for (const table of [
    "item_purchase_price_facts",
    "item_purchase_price_daily",
  ])
    assert.equal(
      (
        await f.pool.query(
          `SELECT document_date::text AS date FROM ${table} WHERE company_id=$1`,
          [s.company.id],
        )
      ).rows[0].date,
      "2026-09-30",
    );
  assert.equal(
    (
      await f.pool.query(
        "SELECT document_date::text AS date FROM financial_documents WHERE company_id=$1",
        [other.company.id],
      )
    ).rows[0].date,
    "2026-10-15",
  );
  assert.equal(
    (await f.owner.ok<{ replayed: boolean }>("POST", path, request)).replayed,
    true,
  );
  assert.equal(
    (
      await f.owner.request("POST", path, {
        ...request,
        sourceSystem: "changed",
      })
    ).status,
    409,
  );
  assert.equal((await importBatch(f, s, input)).replayed, true);
  await assert.rejects(
    f.pool.query(
      "UPDATE stock_movements SET document_date=$1 WHERE company_id=$2",
      ["2026-09-29", s.company.id],
    ),
  );
  const member = await f.member(s.company.id);
  assert.equal((await member.client.request("GET", path + query)).status, 403);
  await f.owner.ok("PUT", "/page-catalog/company.stock-movements/settings", {
    companyId: s.company.id,
    visible: true,
    enabled: false,
    order: 10,
    revision: null,
  });
  assert.equal((await f.owner.request("GET", path + query)).status, 403);
  assert.equal(
    (
      await f.owner.ok<{ status: string }>(
        "GET",
        path + "/status/" + request.idempotencyKey,
      )
    ).status,
    "completed",
  );
  assert.equal(
    (await f.owner.request("GET", path + "/status/" + randomUUID())).status,
    403,
  );
  assert.equal(
    (await f.owner.ok<{ replayed: boolean }>("POST", path, request)).replayed,
    true,
  );
  assert.equal(
    (
      await f.owner.request("POST", path, {
        ...request,
        idempotencyKey: randomUUID(),
      })
    ).status,
    403,
  );
});

test("source-date correction rejects stale previews and rolls back dates, derived projections and receipts when audit fails", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const path = s.base + "/transaction-import/source-dates",
    query = "?sourceSystem=disposable-source-v1";
  await importBatch(f, s, batch([source("voucher", voucher(s))]));
  const stale = await f.owner.ok<SourceDatePreview>("GET", path + query);
  await importBatch(f, s, batch([source("voucher", voucher(s))]));
  assert.equal(
    (
      await f.owner.request("POST", path, {
        idempotencyKey: randomUUID(),
        sourceSystem: "disposable-source-v1",
        snapshotHash: stale.snapshotHash,
      })
    ).status,
    409,
  );
  const preview = await f.owner.ok<SourceDatePreview>("GET", path + query),
    request = {
      idempotencyKey: randomUUID(),
      sourceSystem: "disposable-source-v1",
      snapshotHash: preview.snapshotHash,
    };
  await f.pool.query(
    "CREATE FUNCTION reject_date_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='company.transactions.sourceDates' THEN RAISE EXCEPTION 'date audit rollback test'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER reject_date_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_date_audit()",
  );
  assert.equal((await f.owner.request("POST", path, request)).status, 500);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM transaction_source_date_repairs",
      )
    ).rows[0].n,
    0,
  );
  assert(
    (
      await f.pool.query(
        "SELECT document_date::text AS date FROM financial_documents WHERE company_id=$1",
        [s.company.id],
      )
    ).rows.every((r) => r.date === "2026-10-15"),
  );
  assert.equal(
    (await f.owner.ok<SourceDatePreview>("GET", path + query)).snapshotHash,
    preview.snapshotHash,
  );
  await f.pool.query("DROP TRIGGER reject_date_audit ON audit_events");
  await f.pool.query("DROP FUNCTION reject_date_audit()");
  await f.owner.ok("POST", path, request);
  assert(
    (await f.owner.ok<SourceDatePreview>("GET", path + query)).counts.every(
      (r) => r.pending === 0,
    ),
  );
});

test("long source-date repairs return progress without waiting on actor/company locks and preserve a single accepted UUID", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item(false);
  const input = batch([source("invoice", s.invoice(item.id))]);
  await importBatch(f, s, input);
  const path = s.base + "/transaction-import/source-dates";
  const preview = await f.owner.ok<SourceDatePreview>(
    "GET",
    path + "?sourceSystem=" + input.sourceSystem,
  );
  const request = {
    idempotencyKey: randomUUID(),
    sourceSystem: input.sourceSystem,
    snapshotHash: preview.snapshotHash,
  };
  const statusPath = path + "/status/" + request.idempotencyKey;
  const member = await f.member(s.company.id);
  const blocker = await f.pool.connect();
  await blocker.query("BEGIN");
  try {
    await blocker.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [
      s.company.id,
    ]);
    const accepted = await f.owner.request<{ status: string; stage: string }>(
      "POST",
      path,
      request,
    );
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.status, "processing");
    assert.equal(accepted.body.stage, "waiting_for_transaction_locks");
    const started = Date.now();
    const repeated = await f.owner.request<{ status: string }>(
      "POST",
      path,
      request,
    );
    assert.equal(repeated.status, 202);
    assert.equal(repeated.body.status, "processing");
    const status = await f.owner.ok<{ status: string }>("GET", statusPath);
    assert.equal(status.status, "processing");
    assert(
      Date.now() - started < 2000,
      "Retry/status must not wait for the mutation's actor or company lock",
    );
    assert.equal(
      (
        await f.owner.request("POST", path, {
          ...request,
          sourceSystem: "different-source",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.owner.request("POST", path, {
          ...request,
          idempotencyKey: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal((await member.client.request("GET", statusPath)).status, 403);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  let completed:
    | {
        status: string;
        protectedHistoryUnchanged?: boolean;
        counts?: { pending: number }[];
      }
    | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    completed = await f.owner.ok("GET", statusPath);
    if (completed?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.protectedHistoryUnchanged, true);
  assert(completed?.counts?.every((row) => row.pending === 0));
  assert.equal(
    (await f.owner.ok<{ replayed: boolean }>("POST", path, request)).replayed,
    true,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS count FROM transaction_source_date_repairs WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0].count,
    1,
  );
});
