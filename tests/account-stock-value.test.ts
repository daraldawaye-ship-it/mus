import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { itemPatchSchema } from "../packages/contracts/src/items.ts";
import type {
  Account,
  AccountBalanceStatistics,
  AccountCategory,
  Branch,
  Company,
  CompanyCurrency,
  Employee,
  Item,
  ItemInput,
  ItemPatchInput,
  Location,
  Page,
  Permission,
  SessionResponse,
} from "../packages/contracts/src/index.ts";
import type {
  Invoice,
  InvoiceInput,
} from "../packages/contracts/src/commerce.ts";
import type {
  InventorySettings,
  StockOperation,
} from "../packages/contracts/src/inventory.ts";

// A dedicated local target and disposable schema are mandatory. Never inherit
// the application's DATABASE_URL, including in CI or an operator's shell.
const databaseUrl =
  process.env.ACCOUNT_STOCK_VALUE_TEST_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const target = new URL(databaseUrl);
const localHosts = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "/workspace/.tools/postgresql/socket",
]);
const hosts = [
  target.hostname,
  ...target.searchParams.getAll("host"),
  ...target.searchParams.getAll("hostaddr"),
].filter(Boolean);
assert(
  ["postgres:", "postgresql:"].includes(target.protocol) &&
    hosts.length > 0 &&
    hosts.every((host) => localHosts.has(host)),
  "Account-stock tests require an explicitly local PostgreSQL target",
);
const origin = "http://localhost";
const password = "Local-account-stock-passphrase-2026";

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
  const schema = `account_stock_${randomUUID().replaceAll("-", "")}`;
  let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: Server | undefined;
  t.after(async () => {
    try {
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      await runtime?.close();
    } finally {
      const cleanup = new Pool({ connectionString: databaseUrl });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanup.end();
      }
    }
  });
  runtime = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: false,
  });
  server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const user = await provisionOwner(runtime.pool, {
    name: "Stock statistics owner",
    displayName: "Stock owner",
    email: "owner@account-stock.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  const company = async (name = "Account stock company") =>
    (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        { name, phone: "", address: "" },
        201,
      )
    ).company;
  const member = async (companyId: number, permissions: Permission[]) => {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>(
      "POST",
      "/auth/register",
      {
        name: "Stock employee",
        displayName: "Stock employee",
        email: `${randomUUID()}@account-stock.test`,
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
          name: "Stock employee",
          phone: "",
          role: "employee",
          active: true,
          permissions,
        },
        201,
      )
    ).employee;
    return { client, employee };
  };
  return { pool: runtime.pool, owner, company, member };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setup(f: Fixture, name?: string) {
  const company = await f.company(name),
    base = `/companies/${company.id}`;
  const currencies = (
    await f.owner.ok<Page<CompanyCurrency>>("GET", `${base}/currencies`)
  ).items;
  const yer = currencies.find((value) => value.code === "YER")!,
    usd = currencies.find((value) => value.code === "USD")!;
  const account = async (
    name: string,
    category: AccountCategory = "asset",
    cashOrBank = false,
  ) =>
    (
      await f.owner.ok<{ account: Account }>(
        "POST",
        `${base}/accounts`,
        {
          name,
          parentId: null,
          kind: "posting",
          category,
          normalSide: category === "liability" ? "credit" : "debit",
          cashOrBank,
        },
        201,
      )
    ).account;
  const cash = await account("Stock cash", "asset", true),
    customer = await account("Stock customer");
  const supplier = await account("Stock supplier", "liability"),
    otherSupplier = await account("Other stock supplier", "liability");
  const branch = (await f.owner.ok<Page<Branch>>("GET", `${base}/branches`))
    .items[0]!;
  const showroom = (
    await f.owner.ok<Page<Location>>("GET", `${base}/locations`)
  ).items.find((value) => value.kind === "showroom")!;
  const warehouse = (
    await f.owner.ok<{ location: Location }>(
      "POST",
      `${base}/locations`,
      {
        branchId: branch.id,
        code: "STOCK-WH",
        name: "Stock warehouse",
        kind: "warehouse",
      },
      201,
    )
  ).location;
  const settings = (
    await f.owner.ok<{ settings: InventorySettings }>(
      "GET",
      `${base}/inventory-settings`,
    )
  ).settings;
  const today = (
    await f.pool.query<{ day: string }>(
      "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS day",
    )
  ).rows[0]!.day;
  const item = async (overrides: Partial<ItemInput> = {}) =>
    (
      await f.owner.ok<{ item: Item }>(
        "POST",
        `${base}/items`,
        {
          idempotencyKey: randomUUID(),
          name: "Stock value item",
          unit1Name: "unit",
          unit2Name: "unit",
          unit3Name: "unit",
          factor2: 1,
          factor3: 1,
          purchaseFactor: 1,
          salePrice1: "10",
          salePrice2: "10",
          salePrice3: "10",
          purchasePrice: "2",
          hasExpiry: false,
          currencyId: yer.id,
          supplierAccountId: supplier.id,
          ...overrides,
        },
        201,
      )
    ).item;
  const patchItem = async (
    itemId: number,
    changes: Partial<ItemPatchInput>,
  ) => {
    const current = (
      await f.owner.ok<{ item: Item }>("GET", `${base}/items/${itemId}`)
    ).item;
    // Submit only the real item editor's writable fields; snapshots/labels from
    // the DTO are deliberately excluded from this strict API contract.
    const values = current as unknown as Record<string, unknown>;
    const fields = Object.fromEntries(
      Object.keys(itemPatchSchema.shape)
        .filter((key) => values[key] !== undefined)
        .map((key) => [key, values[key]]),
    );
    return (
      await f.owner.ok<{ item: Item }>("PATCH", `${base}/items/${itemId}`, {
        ...fields,
        ...changes,
        revision: current.revision,
      })
    ).item;
  };
  const invoiceBody = (
    kind: "sale" | "purchase",
    lines: InvoiceInput["lines"],
    overrides: Partial<InvoiceInput> = {},
  ): InvoiceInput => ({
    idempotencyKey: randomUUID(),
    kind,
    documentDate: today,
    currencyId: yer.id,
    branchId: branch.id,
    locationId: showroom.id,
    counterpartyAccountId: kind === "sale" ? customer.id : supplier.id,
    supplierAccountId: kind === "purchase" ? supplier.id : null,
    description: "Stock statistics source",
    discount: "0",
    lines,
    ...overrides,
  });
  const invoice = async (body: InvoiceInput) =>
    (
      await f.owner.ok<{ invoice: Invoice }>(
        "POST",
        `${base}/invoices`,
        body,
        201,
      )
    ).invoice;
  const stats = async (
    accountId = supplier.id,
    asOfDate = today,
    client = f.owner,
  ) =>
    (
      await client.ok<{ statistics: AccountBalanceStatistics }>(
        "GET",
        `${base}/accounts/${accountId}/statistics?asOfDate=${asOfDate}`,
      )
    ).statistics;
  const flag = (
    key: string,
    enabled: boolean,
    revision: number | null = null,
  ) =>
    f.owner.ok<{ page: { revision: number } }>(
      "PUT",
      `/page-catalog/${key}/settings`,
      {
        companyId: company.id,
        visible: true,
        enabled,
        order: 100,
        revision,
      },
    );
  return {
    company,
    base,
    yer,
    usd,
    cash,
    customer,
    supplier,
    otherSupplier,
    branch,
    showroom,
    warehouse,
    settings,
    today,
    item,
    patchItem,
    invoiceBody,
    invoice,
    stats,
    flag,
  };
}

function available(statistics: AccountBalanceStatistics) {
  assert.equal(statistics.stockAvailability, "available");
  assert(statistics.stock);
  assert.equal(statistics.components.stock?.state, "ready");
  assert.equal(statistics.stock.basis, "current_item_card_supplier");
  assert.equal(statistics.stock.scope, "current_transaction_state");
  assert.equal(statistics.stock.valuationMethod, "weighted_average");
  assert(Number.isFinite(Date.parse(statistics.stock.snapshotAt)));
  return statistics.stock;
}

async function humanHistory(f: Fixture, companyId: number) {
  return (
    await f.pool.query<{
      followups: string;
      approvals: string;
      audits: string;
    }>(
      `SELECT (SELECT count(*)::text FROM account_balance_followups WHERE company_id=$1) AS followups,
      (SELECT count(*)::text FROM account_balance_approvals WHERE company_id=$1) AS approvals,
      (SELECT count(*)::text FROM audit_events WHERE company_id=$1) AS audits`,
      [companyId],
    )
  ).rows[0]!;
}

test("current stock value pools each assigned item once across batches, locations and inactive cards", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const product = await s.item({ hasExpiry: true }),
    second = await s.item(),
    empty = await s.item();
  const unassigned = await s.item({ supplierAccountId: null });
  await s.invoice(
    s.invoiceBody("purchase", [
      {
        itemId: product.id,
        unit: 1,
        quantity: "10",
        unitPrice: "2",
        expiryDate: "2030-01-01",
      },
    ]),
  );
  await s.invoice(
    s.invoiceBody(
      "purchase",
      [
        {
          itemId: product.id,
          unit: 1,
          quantity: "5",
          unitPrice: "4",
          expiryDate: "2031-01-01",
        },
      ],
      { locationId: s.warehouse.id },
    ),
  );
  await s.invoice(
    s.invoiceBody("sale", [{ itemId: product.id, unit: 1, quantity: "3" }]),
  );
  await s.invoice(
    s.invoiceBody("purchase", [
      { itemId: second.id, unit: 1, quantity: "3", unitPrice: "7" },
    ]),
  );
  await s.invoice(
    s.invoiceBody("purchase", [
      { itemId: unassigned.id, unit: 1, quantity: "1", unitPrice: "999" },
    ]),
  );
  await s.patchItem(unassigned.id, { supplierAccountId: null });
  const beforeTransfer = available(await s.stats());
  assert.equal(
    beforeTransfer.valueBase,
    "53",
    "32 remaining weighted value plus 21 for the second item",
  );
  await f.owner.ok<{ operation: StockOperation }>(
    "POST",
    `${s.base}/stock-transfers`,
    {
      idempotencyKey: randomUUID(),
      documentDate: s.today,
      itemId: product.id,
      fromLocationId: s.showroom.id,
      toLocationId: s.warehouse.id,
      quantity: "2",
      unit: 1,
      expiryDate: "2030-01-01",
    },
    201,
  );
  await s.patchItem(product.id, { active: false });
  await f.owner.ok("PATCH", `${s.base}/locations/${s.warehouse.id}`, {
    active: false,
  });
  const beforeRead = await humanHistory(f, s.company.id);
  const current = await s.stats(),
    stock = available(current);
  assert.equal(stock.valueBase, "53");
  assert.equal(stock.confirmedValueBase, "53");
  assert.equal(stock.inferredValueBase, "0");
  assert.equal(
    stock.assignedItemCount,
    "3",
    "Assigned empty items count without inventing value",
  );
  assert.equal(stock.inferredItemCount, "0");
  assert.equal(stock.negativeStockItemCount, "0");
  assert.equal(stock.negativeStockValueBase, "0");
  assert.equal(stock.currency.id, s.yer.id);
  assert.equal(stock.asOfDate, s.today);
  const historical = await s.stats(s.supplier.id, "2024-01-01");
  assert.equal(historical.asOfDate, "2024-01-01");
  assert.equal(historical.balance.currentBase, "0");
  assert.equal(
    available(historical).valueBase,
    "53",
    "Historical financial cutoffs do not mislabel current inventory as historical",
  );
  assert.equal(historical.stock!.asOfDate, s.today);
  assert.equal(historical.stock!.scope, "current_transaction_state");
  assert.equal(available(await s.stats(s.otherSupplier.id)).valueBase, "0");
  assert.equal(
    available(await s.stats(s.otherSupplier.id)).assignedItemCount,
    "0",
  );
  assert.deepEqual(
    await humanHistory(f, s.company.id),
    beforeRead,
    "Derived reads never create human history or audits",
  );
  // A ready projection must never expose a partial/invalid monetary snapshot,
  // even if an internal caller writes the cache without the public service.
  for (const change of [
    "stock_value_base='NaN'::numeric",
    "stock_confirmed_value_base=0",
    "stock_value_base=53.000001,stock_confirmed_value_base=53.000001",
    "stock_assigned_items_count=-1",
    "stock_currency_id=NULL",
  ])
    await assert.rejects(
      f.pool.query(
        `UPDATE account_statistics SET ${change} WHERE company_id=$1 AND account_id=$2`,
        [s.company.id, s.supplier.id],
      ),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23514",
    );
  assert.equal(
    available(await s.stats()).valueBase,
    "53",
    "Rejected malformed cache writes leave the valid snapshot intact",
  );
  assert(empty.id > 0);
});

test("supplier reassignment and genuine inferred confirmation move current value without changing historical sources or balance quotes", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    product = await s.item();
  await s.invoice(
    s.invoiceBody("purchase", [
      { itemId: product.id, unit: 1, quantity: "2", unitPrice: "5" },
    ]),
  );
  const original = await s.stats(),
    other = await s.stats(s.otherSupplier.id);
  const sources = async () =>
    (
      await f.pool.query(
        `SELECT * FROM (
       SELECT 'invoice' AS source,to_jsonb(i) AS row FROM invoices i WHERE company_id=$1
       UNION ALL SELECT 'movement',to_jsonb(m) FROM stock_movements m WHERE company_id=$1
     ) sources ORDER BY source,row::text`,
        [s.company.id],
      )
    ).rows;
  const beforeSources = await sources();
  await s.patchItem(product.id, { supplierAccountId: s.otherSupplier.id });
  const movedFrom = await s.stats(),
    movedTo = await s.stats(s.otherSupplier.id);
  assert.equal(available(movedFrom).valueBase, "0");
  assert.equal(available(movedFrom).assignedItemCount, "0");
  assert.equal(available(movedTo).valueBase, "10");
  assert.deepEqual(movedFrom.approvalQuote, original.approvalQuote);
  assert.deepEqual(movedTo.approvalQuote, other.approvalQuote);
  assert.equal(movedFrom.sourceRevision, original.sourceRevision);
  await s.patchItem(product.id, { supplierAccountId: null });
  assert.equal(available(await s.stats()).valueBase, "0");
  assert.equal(available(await s.stats(s.otherSupplier.id)).valueBase, "0");
  // Exercise the real legacy inference routine using the real purchase above.
  // No supplier flag, immutable movement, or valuation is forged by the test.
  assert.equal(
    (
      await f.pool.query<{ count: string }>(
        "SELECT guess_item_source_suppliers()::text AS count",
      )
    ).rows[0]!.count,
    "1",
  );
  const inferred = available(await s.stats());
  assert.equal(inferred.valueBase, "10");
  assert.equal(inferred.confirmedValueBase, "0");
  assert.equal(inferred.inferredValueBase, "10");
  assert.equal(inferred.inferredItemCount, "1");
  const confirmed = await s.patchItem(product.id, {
    supplierAccountId: s.supplier.id,
  });
  assert.equal(confirmed.supplierInferred, false);
  const afterConfirmation = await s.stats(),
    confirmedStock = available(afterConfirmation);
  assert.equal(confirmedStock.valueBase, "10");
  assert.equal(confirmedStock.confirmedValueBase, "10");
  assert.equal(confirmedStock.inferredValueBase, "0");
  assert.equal(
    confirmedStock.inferredItemCount,
    "0",
    "An inference-only change invalidates the stock projection too",
  );
  assert.deepEqual(afterConfirmation.approvalQuote, original.approvalQuote);
  assert.deepEqual(
    await sources(),
    beforeSources,
    "Current attribution never rewrites invoice or movement supplier snapshots",
  );
});

test("negative pooled inventory stays signed and provisional zero-cost shortages remain visible", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    product = await s.item(),
    unknownCost = await s.item();
  await f.owner.ok("PUT", `${s.base}/inventory-settings`, {
    inventoryAccountId: s.settings.inventoryAccountId,
    salesAccountId: s.settings.salesAccountId,
    cogsAccountId: s.settings.cogsAccountId,
    surplusAccountId: s.settings.surplusAccountId,
    shortageAccountId: s.settings.shortageAccountId,
    costingMethod: "weighted_average",
    revision: s.settings.revision,
    allowNegative: true,
  });
  await s.invoice(
    s.invoiceBody("purchase", [
      { itemId: product.id, unit: 1, quantity: "2", unitPrice: "5" },
    ]),
  );
  await s.invoice(
    s.invoiceBody("sale", [
      { itemId: product.id, unit: 1, quantity: "3" },
      { itemId: unknownCost.id, unit: 1, quantity: "2" },
    ]),
  );
  const deficit = available(await s.stats());
  assert.equal(deficit.valueBase, "-5");
  assert.equal(deficit.confirmedValueBase, "-5");
  assert.equal(
    deficit.negativeStockItemCount,
    "2",
    "Quantity deficits are counted even when provisional cost is zero",
  );
  assert.equal(deficit.negativeStockValueBase, "-5");
  await s.invoice(
    s.invoiceBody("purchase", [
      { itemId: product.id, unit: 1, quantity: "2", unitPrice: "8" },
    ]),
  );
  const replenished = available(await s.stats());
  assert.equal(
    replenished.valueBase,
    "8",
    "Read the post-replenishment pool after the domain service books variance",
  );
  assert.equal(replenished.negativeStockItemCount, "1");
  assert.equal(replenished.negativeStockValueBase, "0");
});

test("stock costs retain exact large amounts and historical FX without repricing on rate changes", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    product = await s.item();
  await f.owner.ok(
    "POST",
    `${s.base}/exchange-rates`,
    {
      currencyId: s.usd.id,
      rate: "100.125",
      effectiveAt: `${s.today}T00:00:00Z`,
      source: "Exact stock FX",
    },
    201,
  );
  await s.invoice(
    s.invoiceBody("purchase", [
      {
        itemId: product.id,
        unit: 1,
        quantity: "1",
        unitPrice: "9007199254740993.25",
      },
    ]),
  );
  await s.invoice(
    s.invoiceBody(
      "purchase",
      [{ itemId: product.id, unit: 1, quantity: "1", unitPrice: "0.04" }],
      { currencyId: s.usd.id },
    ),
  );
  const before = available(await s.stats());
  assert.equal(before.valueBase, "9007199254740997.26");
  assert.equal(before.confirmedValueBase, "9007199254740997.26");
  assert.equal(before.assignedItemCount, "1");
  assert.equal(before.currency.code, "YER");
  await f.owner.ok(
    "POST",
    `${s.base}/exchange-rates`,
    {
      currencyId: s.usd.id,
      rate: "999",
      effectiveAt: `${s.today}T00:00:01Z`,
      source: "Later rate must not reprice existing inventory",
    },
    201,
  );
  assert.equal(available(await s.stats()).valueBase, before.valueBase);
});

test("current transaction-state inventory includes posted future-dated sources while financial cutoffs exclude them", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    product = await s.item();
  const tomorrow = (
    await f.pool.query<{ day: string }>(
      "SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date+1)::text AS day",
    )
  ).rows[0]!.day;
  await s.invoice(
    s.invoiceBody(
      "purchase",
      [{ itemId: product.id, unit: 1, quantity: "2", unitPrice: "5" }],
      { documentDate: tomorrow },
    ),
  );
  const current = await s.stats(),
    stock = available(current);
  assert.equal(current.balance.currentBase, "0");
  assert.equal(current.operations.purchase?.documentsAllTime, "0");
  assert.equal(stock.valueBase, "10");
  assert.equal(stock.asOfDate, s.today);
  assert.equal(
    stock.scope,
    "current_transaction_state",
    "The label describes stored operational state rather than a reconstructed dated pool",
  );
});

test("stock value and metadata require current item and both inventory views while financial balances remain readable", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    foreign = await setup(f, "Foreign stock company"),
    product = await s.item();
  await s.invoice(
    s.invoiceBody("purchase", [
      { itemId: product.id, unit: 1, quantity: "2", unitPrice: "5" },
    ]),
  );
  const baseGrants: Permission[] = ["accounts.view", "finance.view"];
  const financeOnly = await f.member(s.company.id, baseGrants);
  const inventoryOnly = await f.member(s.company.id, [
    ...baseGrants,
    "inventory.view",
  ]);
  const itemsOnly = await f.member(s.company.id, [...baseGrants, "items.view"]);
  const permitted = await f.member(s.company.id, [
    ...baseGrants,
    "items.view",
    "inventory.view",
  ]);
  const foreignMember = await f.member(foreign.company.id, [
    ...baseGrants,
    "items.view",
    "inventory.view",
  ]);
  const full = await s.stats();
  const assertRestricted = (statistics: AccountBalanceStatistics) => {
    assert.equal(statistics.balance.currentBase, full.balance.currentBase);
    assert.equal(statistics.stockAvailability, "restricted");
    assert.equal(statistics.stock, null);
    assert.equal(
      statistics.components.stock,
      null,
      "No stock revision, readiness or compute time leaks through metadata",
    );
  };
  for (const member of [financeOnly, inventoryOnly, itemsOnly])
    assertRestricted(await s.stats(s.supplier.id, s.today, member.client));
  assert.equal(
    available(await s.stats(s.supplier.id, s.today, permitted.client))
      .valueBase,
    "10",
    "Inventory cost does not require granting invoice/commerce access",
  );
  for (const key of [
    "company.items",
    "company.stock-balances",
    "company.stock-movements",
  ]) {
    const disabled = await s.flag(key, false);
    assertRestricted(await s.stats(s.supplier.id, s.today, permitted.client));
    await s.flag(key, true, disabled.page.revision);
    assert.equal(
      available(await s.stats(s.supplier.id, s.today, permitted.client))
        .valueBase,
      "10",
    );
  }
  await f.owner.ok("PUT", `${s.base}/configuration/employee-rules`, {
    employeeId: permitted.employee.id,
    permissionKey: "company.stock-movements:view",
    effect: "deny",
    revision: null,
  });
  assertRestricted(await s.stats(s.supplier.id, s.today, permitted.client));
  assert.equal(
    (
      await foreignMember.client.request(
        "GET",
        `${s.base}/accounts/${s.supplier.id}/statistics`,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.owner.request(
        "GET",
        `${s.base}/accounts/${foreign.supplier.id}/statistics`,
      )
    ).status,
    404,
  );
});

test("transaction reset zeros derived stock, rotates the source generation and preserves human balance history", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    product = await s.item();
  await s.invoice(
    s.invoiceBody("purchase", [
      { itemId: product.id, unit: 1, quantity: "2", unitPrice: "5" },
    ]),
  );
  const before = await s.stats();
  assert.equal(available(before).valueBase, "10");
  await f.owner.ok(
    "POST",
    `${s.base}/accounts/${s.supplier.id}/balance-followups`,
    {
      idempotencyKey: randomUUID(),
      note: "Human follow-up survives resetting transaction sources",
    },
    201,
  );
  await f.owner.ok(
    "POST",
    `${s.base}/accounts/${s.supplier.id}/balance-approvals`,
    {
      ...before.approvalQuote,
      idempotencyKey: randomUUID(),
      note: "Preserved pre-reset approval",
    },
    201,
  );
  const preview = await f.owner.ok<{
    snapshotHash: string;
    companyName: string;
    blockers: string[];
  }>("GET", `${s.base}/transaction-reset`);
  assert.deepEqual(preview.blockers, []);
  await f.owner.ok("POST", `${s.base}/transaction-reset`, {
    idempotencyKey: randomUUID(),
    snapshotHash: preview.snapshotHash,
    confirmationCompanyName: preview.companyName,
    deleteAllTransactions: true,
  });
  const after = await s.stats(),
    stock = available(after);
  assert.notEqual(after.sourceGeneration, before.sourceGeneration);
  assert.equal(stock.valueBase, "0");
  assert.equal(stock.confirmedValueBase, "0");
  assert.equal(stock.inferredValueBase, "0");
  assert.equal(
    stock.assignedItemCount,
    "1",
    "A reset preserves the item and its current supplier assignment",
  );
  assert.equal(stock.negativeStockItemCount, "0");
  assert(after.lastFollowUp);
  assert.equal(
    after.lastApproval,
    null,
    "A preserved approval from the prior generation is not current",
  );
  const history = await humanHistory(f, s.company.id);
  assert.equal(history.followups, "1");
  assert.equal(history.approvals, "1");
  await s.invoice(
    s.invoiceBody("purchase", [
      { itemId: product.id, unit: 1, quantity: "1", unitPrice: "3" },
    ]),
  );
  assert.equal(available(await s.stats()).valueBase, "3");
});
