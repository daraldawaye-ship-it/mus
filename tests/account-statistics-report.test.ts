import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import {
  accountStatisticCell,
  accountStatisticsMetricDefinitions,
  accountStatisticsReportQuerySchema,
  type Account,
  type AccountBalanceApproval,
  type AccountBalanceFollowUp,
  type AccountBalanceStatistics,
  type AccountCategory,
  type AccountChoice,
  type AccountStatisticsReport,
  type Branch,
  type Company,
  type CompanyCurrency,
  type Employee,
  type FinancialDocument,
  type FinancialDocumentInput,
  type Item,
  type Page,
  type Permission,
  type SessionResponse,
} from "../packages/contracts/src/index.ts";
import type {
  Invoice,
  InvoiceInput,
} from "../packages/contracts/src/commerce.ts";

// Dedicated local target only: never inherit the application's DATABASE_URL.
const databaseUrl =
  process.env.ACCOUNT_STATISTICS_REPORT_TEST_DATABASE_URL ??
  DEFAULT_DATABASE_URL;
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
  "Account report tests require an explicitly local PostgreSQL target",
);
const origin = "http://localhost",
  password = "Local-account-report-passphrase-2026";
const cutoff = "2024-03-02";

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
  const schema = `account_report_${randomUUID().replaceAll("-", "")}`;
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
  const ownerUser = await provisionOwner(runtime.pool, {
    name: "Report owner",
    displayName: "Report owner",
    email: "owner@account-report.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: ownerUser.email, password });
  const company = async (name = "Statistics report company") =>
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
        name: "Report employee",
        displayName: "Report employee",
        email: `${randomUUID()}@account-report.test`,
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
          name: "Report employee",
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
  return { owner, pool: runtime.pool, company, member };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setup(f: Fixture, name?: string) {
  const company = await f.company(name),
    base = `/companies/${company.id}`;
  const currencies = (
    await f.owner.ok<Page<CompanyCurrency>>("GET", `${base}/currencies`)
  ).items;
  const yer = currencies.find((currency) => currency.code === "YER")!,
    usd = currencies.find((currency) => currency.code === "USD")!;
  const account = async (
    name: string,
    options: {
      category?: AccountCategory;
      accountChoice?: AccountChoice | null;
      group?: boolean;
      cashOrBank?: boolean;
    } = {},
  ) =>
    (
      await f.owner.ok<{ account: Account }>(
        "POST",
        `${base}/accounts`,
        {
          name,
          parentId: null,
          kind: options.group ? "group" : "posting",
          category: options.category ?? "asset",
          normalSide: "debit",
          cashOrBank: options.cashOrBank ?? false,
          ...(options.accountChoice !== undefined
            ? { accountChoice: options.accountChoice }
            : {}),
        },
        201,
      )
    ).account;
  const customer = await account("Report target customer"),
    supplier = await account("Report target supplier", {
      category: "liability",
    });
  const cash = await account("Report cash", { cashOrBank: true });
  const branch = (await f.owner.ok<Page<Branch>>("GET", `${base}/branches`))
    .items[0]!;
  const locations = (
    await f.owner.ok<Page<{ id: number; kind: string }>>(
      "GET",
      `${base}/locations`,
    )
  ).items;
  const location = locations.find((value) => value.kind === "showroom")!;
  const draft = async (
    kind: "journal" | "payment" | "receipt",
    date: string,
    amount: string,
    accountId = customer.id,
    currencyId = yer.id,
    credit = false,
  ) => {
    const debited = kind === "receipt" || credit ? cash.id : accountId;
    const credited = kind === "receipt" || credit ? accountId : cash.id;
    return (
      await f.owner.ok<{ document: FinancialDocument }>(
        "POST",
        `${base}/financial-documents`,
        {
          idempotencyKey: randomUUID(),
          kind,
          documentDate: date,
          currencyId,
          branchId: null,
          cashAccountId: kind === "journal" ? null : cash.id,
          description: "Report source",
          lines: [
            { accountId: debited, debit: amount, credit: "0" },
            { accountId: credited, debit: "0", credit: amount },
          ],
        } satisfies FinancialDocumentInput,
        201,
      )
    ).document;
  };
  const post = async (
    kind: "journal" | "payment" | "receipt",
    date: string,
    amount: string,
    accountId = customer.id,
    currencyId = yer.id,
    credit = false,
  ) => {
    const document = await draft(
      kind,
      date,
      amount,
      accountId,
      currencyId,
      credit,
    );
    return (
      await f.owner.ok<{ document: FinancialDocument }>(
        "POST",
        `${base}/financial-documents/${document.id}/post`,
        { revision: document.revision },
      )
    ).document;
  };
  const stats = async (
    accountId = customer.id,
    asOfDate = cutoff,
    client = f.owner,
  ) =>
    (
      await client.ok<{ statistics: AccountBalanceStatistics }>(
        "GET",
        `${base}/accounts/${accountId}/statistics?asOfDate=${asOfDate}`,
      )
    ).statistics;
  const reportPath = (query: Record<string, string> = {}) =>
    `${base}/account-statistics-report?${new URLSearchParams({ asOfDate: cutoff, ...query })}`;
  const report = async (query: Record<string, string> = {}, client = f.owner) =>
    (
      await client.ok<{ report: AccountStatisticsReport }>(
        "GET",
        reportPath(query),
      )
    ).report;
  const product = async () =>
    (
      await f.owner.ok<{ item: Item }>(
        "POST",
        `${base}/items`,
        {
          idempotencyKey: randomUUID(),
          name: "Report assigned stock item",
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
        },
        201,
      )
    ).item;
  const invoice = async (
    kind: "sale" | "purchase",
    date: string,
    lines: InvoiceInput["lines"],
    overrides: Partial<InvoiceInput> = {},
  ) =>
    (
      await f.owner.ok<{ invoice: Invoice }>(
        "POST",
        `${base}/invoices`,
        {
          idempotencyKey: randomUUID(),
          kind,
          documentDate: date,
          currencyId: yer.id,
          branchId: branch.id,
          locationId: location.id,
          counterpartyAccountId: kind === "sale" ? customer.id : supplier.id,
          supplierAccountId: kind === "purchase" ? supplier.id : null,
          description: "Report invoice source",
          discount: "0",
          lines,
          ...overrides,
        } satisfies InvoiceInput,
        201,
      )
    ).invoice;
  const flag = (
    key: string,
    enabled: boolean,
    revision: number | null = null,
  ) =>
    f.owner.ok<{ page: { revision: number } }>(
      "PUT",
      `/page-catalog/${key}/settings`,
      { companyId: company.id, enabled, visible: true, order: 100, revision },
    );
  const deny = (employeeId: number, permissionKey: string) =>
    f.owner.ok("PUT", `${base}/configuration/employee-rules`, {
      employeeId,
      permissionKey,
      effect: "deny",
      revision: null,
    });
  return {
    company,
    base,
    yer,
    usd,
    customer,
    supplier,
    cash,
    account,
    draft,
    post,
    stats,
    report,
    reportPath,
    product,
    invoice,
    flag,
    deny,
  };
}

function row(report: AccountStatisticsReport, account: Account) {
  const result = report.rows.find((value) => value.account.id === account.id);
  assert(result, `Missing report row ${account.name}`);
  return result;
}
async function snapshot(f: Fixture, companyId: number) {
  return (
    await f.pool.query(
      `SELECT
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY account_id) FROM account_statistics s WHERE company_id=$1) AS statistics,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY account_id,document_date,currency_id,family) FROM account_daily_activity d WHERE company_id=$1) AS daily,
    (SELECT count(*)::text FROM account_balance_followups WHERE company_id=$1) AS followups,
    (SELECT count(*)::text FROM account_balance_approvals WHERE company_id=$1) AS approvals,
    (SELECT count(*)::text FROM audit_events WHERE company_id=$1) AS audits`,
      [companyId],
    )
  ).rows[0];
}

test("report catalog contains exactly the agreed 50 fields and query parsing is bounded and strict", () => {
  assert.equal(accountStatisticsMetricDefinitions.length, 50);
  assert.equal(
    new Set(accountStatisticsMetricDefinitions.map((metric) => metric.key))
      .size,
    50,
  );
  assert(
    !accountStatisticsMetricDefinitions.some((metric) =>
      /supplier|automatic/i.test(metric.key),
    ),
  );
  const defaults = accountStatisticsReportQuerySchema.parse({});
  assert.equal(defaults.metrics.length, 6);
  assert.equal(defaults.pageSize, 20);
  assert(
    accountStatisticsReportQuerySchema.safeParse({ pageSize: "100" }).success,
  );
  for (const query of [
    { pageSize: "101" },
    { page: "0" },
    { page: "1e3" },
    { page: "1000001" },
    { pageSize: "2.5" },
    { metrics: "unknown" },
    { metrics: "lastSaleDate,lastSaleDate" },
    {
      metrics: accountStatisticsMetricDefinitions
        .slice(0, 9)
        .map((metric) => metric.key)
        .join(","),
    },
    { sort: "lastSaleAmount:desc" },
    { sort: "code:asc,code:desc" },
    { sort: "name:desc:extra" },
    { sort: "code:asc;SELECT 1" },
    {
      sort: "code:asc,name:asc,active:asc,lastSaleDate:asc,lastSaleAmount:asc,lastPurchaseDate:asc",
    },
    { asOfDate: "2024-02-30" },
    { asOfDate: "0002-12-31" },
    { category: "asset' OR true--" },
    { metrics: ["lastSaleDate"] },
    { "metrics[0]": "lastSaleDate" },
    { unknown: "value" },
  ])
    assert(
      !accountStatisticsReportQuerySchema.safeParse(query).success,
      JSON.stringify(query),
    );
});

test("cold report reads all 50 cells from exact sources without warming caches, then agrees with account cards", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.product();
  await s.post("journal", "2021-12-31", "9007199254740993.25");
  await s.post("journal", "2023-01-01", "5.25");
  await s.post("journal", "2023-03-02", "1");
  await s.post("payment", "2024-02-29", "7");
  const cancelled = await s.post("payment", "2024-03-01", "11");
  await f.owner.ok(
    "POST",
    `${s.base}/financial-documents/${cancelled.id}/reverse`,
    {
      idempotencyKey: randomUUID(),
      documentDate: cutoff,
      reason: "Report reversal",
    },
  );
  for (const [date, amount] of [
    ["2024-01-01", "13"],
    ["2024-02-29", "17"],
    [cutoff, "19"],
    ["2024-03-03", "23"],
  ])
    await s.post("receipt", date!, amount!);
  await s.draft("payment", cutoff, "999999");
  await s.invoice("purchase", "2024-01-01", [
    { itemId: item.id, unit: 1, quantity: "20", unitPrice: "2" },
  ]);
  await s.invoice(
    "purchase",
    "2024-02-29",
    [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "2" }],
    { counterpartyAccountId: s.cash.id },
  );
  const sale = await s.invoice("sale", "2024-03-01", [
    { itemId: item.id, unit: 1, quantity: "3" },
  ]);
  assert(
    sale.financialDocumentId && sale.costDocumentId,
    "Fixture must actually exercise deduplication of linked journals",
  );
  await s.invoice("purchase", "2024-03-03", [
    { itemId: item.id, unit: 1, quantity: "1", unitPrice: "3" },
  ]);
  const before = await snapshot(f, s.company.id);
  const coldCells = new Map<
    number,
    Record<string, ReturnType<typeof accountStatisticCell>>
  >();
  for (let offset = 0; offset < 50; offset += 8) {
    const metrics = accountStatisticsMetricDefinitions
      .slice(offset, offset + 8)
      .map((metric) => metric.key)
      .join(",");
    const report = await s.report({ metrics, q: "Report target" });
    assert.equal(report.total, 2);
    assert.equal(report.coverage, "recorded_history_only");
    assert.equal(report.asOfDate, cutoff);
    assert.equal(report.currency.code, "YER");
    assert(
      report.currentStockDate > cutoff,
      "Stock must retain its own current date",
    );
    assert(report.metrics.every((metric) => metric.available));
    for (const result of report.rows)
      coldCells.set(result.account.id, {
        ...coldCells.get(result.account.id),
        ...result.values,
      });
  }
  assert.deepEqual(
    await snapshot(f, s.company.id),
    before,
    "The table must neither hydrate every account cache nor record human events/audits",
  );
  const customer = coldCells.get(s.customer.id)!,
    supplier = coldCells.get(s.supplier.id)!;
  assert.equal(customer.balanceOneYearAgoBase!.value, "9007199254740999.5");
  assert.equal(
    customer.balanceAtCurrentYearStartBase!.value,
    "9007199254740999.5",
  );
  assert.equal(
    customer.balanceAtPreviousYearStartBase!.value,
    "9007199254740993.25",
  );
  assert.equal(
    customer.balanceAtTwoYearsAgoStartBase!.value,
    "9007199254740993.25",
  );
  assert.equal(
    customer.activityDocumentsAllTime!.value,
    "10",
    "Three journals, three payment events, three receipts, one invoice",
  );
  assert.equal(
    customer.saleDocumentsAllTime!.value,
    "1",
    "Primary and cost journals must not double count the sale",
  );
  assert.equal(
    customer.paymentDocumentsFourMonths!.value,
    "3",
    "Reversal is a dated signed event, draft is excluded",
  );
  assert.equal(customer.paymentsCurrentMonthBase!.value, "0");
  assert.equal(customer.paymentsPreviousMonthBase!.value, "7");
  assert.equal(
    customer.receiptsCurrentWeekBase!.value,
    "19",
    "Saturday begins the week",
  );
  assert.equal(customer.receiptsLast7DaysBase!.value, "36");
  assert.equal(customer.lastPaymentDate!.value, "2024-02-29");
  assert.equal(customer.lastPaymentAmount!.value, "7");
  assert.equal(customer.lastSaleAmount!.source?.sourceId, sale.id);
  assert.equal(supplier.purchasesFourMonthsBase!.value, "44");
  assert.equal(supplier.cashPurchasesFourMonthsBase!.value, "4");
  assert.equal(
    supplier.purchasesCurrentMonthBase!.value,
    "0",
    "Future purchase excluded from historical commerce",
  );
  assert.equal(
    supplier.assignedItemsStockValueBase!.value,
    "41",
    "Current pool includes already posted future-dated purchase",
  );
  assert.equal(supplier.lastPurchaseAmount!.value, "4");
  assert.equal(supplier.lastApprovedBalanceBase!.unavailableReason, "none");
  for (const account of [s.customer, s.supplier]) {
    // Build a differently dated cache first: table results cannot depend on it.
    await s.stats(account.id, "2024-01-01");
    const statistics = await s.stats(account.id);
    for (const metric of accountStatisticsMetricDefinitions)
      assert.deepEqual(
        coldCells.get(account.id)![metric.key],
        accountStatisticCell(statistics, metric.key),
        `${account.name}: ${metric.key}`,
      );
  }
});

test("numeric ranking is exact across pages, signed ties are stable and latest amounts rank by base currency", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const a = await s.account("Rank account A"),
    b = await s.account("Rank account B"),
    c = await s.account("Rank account C"),
    d = await s.account("Rank account D"),
    empty = await s.account("Rank account E");
  await s.post("journal", "2022-01-01", "9007199254740993.01", a.id);
  await s.post("journal", "2022-01-01", "9007199254740993.02", b.id);
  await s.post("journal", "2022-01-01", "5", c.id, s.yer.id, true);
  await s.post("journal", "2022-01-01", "5", d.id, s.yer.id, true);
  const query = {
    q: "Rank account",
    metrics: "balanceOneYearAgoBase",
    sort: "balanceOneYearAgoBase:desc",
    pageSize: "2",
  };
  const first = await s.report(query),
    second = await s.report({ ...query, page: "2" }),
    third = await s.report({ ...query, page: "3" });
  assert.equal(first.total, 5);
  assert.deepEqual(
    [...first.rows, ...second.rows, ...third.rows].map(
      (result) => result.account.id,
    ),
    [b.id, a.id, empty.id, c.id, d.id],
  );
  assert.equal(
    first.rows[0]!.values.balanceOneYearAgoBase!.value,
    "9007199254740993.02",
  );
  assert.equal(second.rows[1]!.values.balanceOneYearAgoBase!.value, "-5");
  const reversedTies = await s.report({
    ...query,
    pageSize: "100",
    sort: "balanceOneYearAgoBase:asc,name:desc",
  });
  assert.deepEqual(
    reversedTies.rows.map((result) => result.account.id),
    [d.id, c.id, empty.id, a.id, b.id],
  );
  await f.owner.ok(
    "POST",
    `${s.base}/exchange-rates`,
    {
      currencyId: s.usd.id,
      rate: "100",
      effectiveAt: "2024-01-01T00:00:00Z",
      source: "Exact report sort rate",
    },
    201,
  );
  await s.post("receipt", cutoff, "2", a.id, s.usd.id);
  await s.post("receipt", cutoff, "50", b.id);
  const amounts = await s.report({
    q: "Rank account",
    metrics: "lastReceiptAmount",
    sort: "lastReceiptAmount:desc",
  });
  assert.deepEqual(
    amounts.rows.slice(0, 2).map((result) => result.account.id),
    [a.id, b.id],
  );
  assert.deepEqual(row(amounts, a).values.lastReceiptAmount, {
    value: "2",
    currencyCode: "USD",
    baseAmount: "200",
    baseCurrencyCode: "YER",
    source: {
      sourceKind: "financial_document",
      sourceId: row(amounts, a).values.lastReceiptAmount!.source!.sourceId,
      documentNumber: row(amounts, a).values.lastReceiptAmount!.source!
        .documentNumber,
    },
    unavailableReason: null,
  });
  assert(
    amounts.rows
      .slice(2)
      .every(
        (result) =>
          result.values.lastReceiptAmount!.unavailableReason === "none",
      ),
  );
  const asc = await s.report({
    q: "Rank account",
    metrics: "lastReceiptAmount",
    sort: "lastReceiptAmount:asc",
  });
  assert.deepEqual(
    asc.rows.map((result) => result.account.id),
    [b.id, a.id, c.id, d.id, empty.id],
    "Null amounts remain last in both directions",
  );
});

test("restricted metrics redact all monetary/source data and cannot be used as an ordering side channel", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await setup(f, "Foreign report company"),
    item = await s.product();
  await s.invoice("purchase", cutoff, [
    { itemId: item.id, unit: 1, quantity: "2", unitPrice: "3" },
  ]);
  await s.invoice("sale", cutoff, [
    { itemId: item.id, unit: 1, quantity: "1" },
  ]);
  await s.post("receipt", cutoff, "7");
  const basic = await f.member(s.company.id, ["accounts.view", "finance.view"]);
  const full = await f.member(s.company.id, [
    "accounts.view",
    "finance.view",
    "commerce.view",
    "items.view",
    "inventory.view",
  ]);
  const foreign = await f.member(other.company.id, [
    "accounts.view",
    "finance.view",
    "commerce.view",
  ]);
  const metrics =
    "balanceOneYearAgoBase,activityDocumentsAllTime,lastSaleAmount,lastPurchaseDate,assignedItemsStockValueBase,lastReceiptAmount";
  const limited = await s.report({ q: s.customer.name, metrics }, basic.client);
  const visible = row(limited, s.customer);
  assert.equal(visible.values.balanceOneYearAgoBase!.value, "0");
  assert.equal(visible.values.lastReceiptAmount!.value, "7");
  for (const key of [
    "activityDocumentsAllTime",
    "lastSaleAmount",
    "lastPurchaseDate",
    "assignedItemsStockValueBase",
  ]) {
    assert.equal(
      limited.metrics.find((metric) => metric.key === key)!.available,
      false,
    );
    assert.deepEqual(visible.values[key], {
      value: null,
      currencyCode: null,
      baseAmount: null,
      baseCurrencyCode: null,
      source: null,
      unavailableReason: "restricted",
    });
    assert.equal(
      (
        await basic.client.request(
          "GET",
          s.reportPath({ metrics, sort: `${key}:desc` }),
        )
      ).status,
      403,
    );
  }
  await s.deny(full.employee.id, "company.invoice:view");
  const deniedAlias = await s.report(
    { q: s.customer.name, metrics },
    full.client,
  );
  assert.equal(
    row(deniedAlias, s.customer).values.lastSaleAmount!.unavailableReason,
    "restricted",
  );
  assert.equal(
    row(deniedAlias, s.customer).values.lastPurchaseDate!.unavailableReason,
    "restricted",
  );
  assert.equal(
    row(deniedAlias, s.customer).values.activityDocumentsAllTime!
      .unavailableReason,
    "restricted",
  );
  assert.equal(
    row(deniedAlias, s.customer).values.assignedItemsStockValueBase!.value,
    "0",
    "An invoice deny does not widen to unrelated current stock access",
  );
  const saleFlag = await s.flag("company.sales", false);
  const flagged = await s.report({ q: s.customer.name, metrics });
  assert.equal(
    row(flagged, s.customer).values.lastSaleAmount!.unavailableReason,
    "restricted",
  );
  assert.equal(
    (
      await f.owner.request(
        "GET",
        s.reportPath({ metrics, sort: "lastSaleAmount:desc" }),
      )
    ).status,
    403,
  );
  await s.flag("company.sales", true, saleFlag.page.revision);
  assert.equal(
    (await foreign.client.request("GET", s.reportPath())).status,
    403,
  );
  assert.equal(
    (await s.report({ q: other.customer.name })).rows.some(
      (result) => result.account.id === other.customer.id,
    ),
    false,
  );
  await s.deny(basic.employee.id, "company.account-statistics:view");
  assert.equal((await basic.client.request("GET", s.reportPath())).status, 403);
  const ledgerFlag = await s.flag("company.account-ledger", false);
  assert.equal((await f.owner.request("GET", s.reportPath())).status, 403);
  await s.flag("company.account-ledger", true, ledgerFlag.page.revision);
  await f.owner.ok("PATCH", `${s.base}/employees/${full.employee.id}`, {
    active: false,
  });
  assert.equal(
    (await full.client.request("GET", s.reportPath())).status,
    403,
    "Current employee membership is rechecked on every report",
  );
});

test("latest human values are server events, custom option history stays separate and reset excludes prior-generation approvals", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  await s.post("journal", "2023-01-01", "5.25");
  const definition = (
    await f.owner.ok<{ option: { id: number } }>(
      "POST",
      `${s.base}/configuration/options`,
      {
        key: "report.legacy_balance_followup",
        name: "Legacy follow-up",
        pageKey: "company.accounts",
        recordKind: "account",
        valueType: "date",
      },
      201,
    )
  ).option;
  const optionsPath = `${s.base}/configuration/record-options?recordKind=account&recordId=${s.customer.id}`;
  await f.owner.ok("PUT", optionsPath, {
    definitionId: definition.id,
    value: "2020-01-01",
    revision: null,
  });
  const optionsBefore = await f.owner.ok("GET", optionsPath);
  const metrics =
    "lastBalanceFollowUpAt,lastApprovedBalanceBase,balanceOneYearAgoBase";
  assert.equal(
    row(await s.report({ q: s.customer.name, metrics }), s.customer).values
      .lastBalanceFollowUpAt!.value,
    null,
  );
  const followUp = (
    await f.owner.ok<{ followUp: AccountBalanceFollowUp }>(
      "POST",
      `${s.base}/accounts/${s.customer.id}/balance-followups`,
      { idempotencyKey: randomUUID(), note: "Actual server follow-up" },
      201,
    )
  ).followUp;
  const statistics = await s.stats();
  const approval = (
    await f.owner.ok<{ approval: AccountBalanceApproval }>(
      "POST",
      `${s.base}/accounts/${s.customer.id}/balance-approvals`,
      {
        idempotencyKey: randomUUID(),
        note: "Actual server approval",
        ...statistics.approvalQuote,
      },
      201,
    )
  ).approval;
  const beforeReset = await s.report({
    metrics,
    sort: "lastBalanceFollowUpAt:desc",
  });
  assert.equal(
    beforeReset.rows[0]!.account.id,
    s.customer.id,
    "An event sorts before null values",
  );
  assert.equal(
    row(beforeReset, s.customer).values.lastBalanceFollowUpAt!.value,
    followUp.followedUpAt,
  );
  assert.equal(
    row(beforeReset, s.customer).values.lastApprovedBalanceBase!.value,
    approval.balanceBase,
  );
  assert.equal(approval.balanceBase, "5.25");
  assert.deepEqual(await f.owner.ok("GET", optionsPath), optionsBefore);
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
  const afterReset = row(
    await s.report({ q: s.customer.name, metrics }),
    s.customer,
  );
  assert.equal(afterReset.values.lastApprovedBalanceBase!.value, null);
  assert.equal(
    afterReset.values.lastApprovedBalanceBase!.unavailableReason,
    "none",
  );
  assert.equal(afterReset.values.balanceOneYearAgoBase!.value, "0");
  assert.equal(
    afterReset.values.lastBalanceFollowUpAt!.value,
    followUp.followedUpAt,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::text AS count FROM account_balance_approvals WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0]!.count,
    "1",
    "Historical approval remains immutable after the reset",
  );
  assert.deepEqual(await f.owner.ok("GET", optionsPath), optionsBefore);
});

test("list filters exclude groups, keep archival separate from account choice and reject malformed HTTP queries", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const active = await s.account("Filter chosen account", {
    accountChoice: "customer",
  });
  const unset = await s.account("Filter unset account", {
    accountChoice: null,
  });
  const archived = await s.account("Filter archived account", {
    category: "liability",
    accountChoice: "customer",
  });
  const group = await s.account("Filter group account", { group: true });
  await f.owner.ok("PATCH", `${s.base}/accounts/${archived.id}`, {
    active: false,
  });
  assert.deepEqual(
    (await s.report({ q: "Filter" })).rows.map((result) => result.account.id),
    [active.id, unset.id],
  );
  assert.deepEqual(
    (await s.report({ q: "Filter", active: "archived" })).rows.map(
      (result) => result.account.id,
    ),
    [archived.id],
  );
  assert.deepEqual(
    (
      await s.report({ q: "Filter", active: "all", accountChoice: "customer" })
    ).rows.map((result) => result.account.id),
    [active.id, archived.id],
  );
  assert.deepEqual(
    (
      await s.report({ q: "Filter", active: "all", accountChoice: "unset" })
    ).rows.map((result) => result.account.id),
    [unset.id],
  );
  assert.deepEqual(
    (
      await s.report({ q: "Filter", active: "all", category: "liability" })
    ).rows.map((result) => result.account.id),
    [archived.id],
  );
  assert(
    !(await s.report({ q: "Filter", active: "all" })).rows.some(
      (result) => result.account.id === group.id,
    ),
  );
  assert.equal((await s.report({ q: "Filter", page: "9999" })).total, 2);
  assert.deepEqual((await s.report({ q: "Filter", page: "9999" })).rows, []);
  assert.equal((await s.report({ q: "'; DROP TABLE accounts;--" })).total, 0);
  for (const tail of [
    "metrics=unknown",
    "metrics=lastSaleDate&metrics=lastReceiptDate",
    "metrics%5B0%5D=lastSaleDate",
    "sort=code%3Aasc%3BSELECT%201",
    "pageSize=101",
    "unexpected=true",
    "asOfDate=9999-01-01",
  ])
    assert.equal(
      (
        await f.owner.request(
          "GET",
          `${s.base}/account-statistics-report?${tail}`,
        )
      ).status,
      400,
      tail,
    );
  const defaultDate = (
    await f.owner.ok<{ report: AccountStatisticsReport }>(
      "GET",
      `${s.base}/account-statistics-report`,
    )
  ).report;
  assert(defaultDate.asOfDate >= cutoff);
});
