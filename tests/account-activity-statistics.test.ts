import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Account, AccountBalanceStatistics, AccountCategory, Branch, Company,
  CompanyCurrency, Employee, FinancialDocument, FinancialDocumentInput,
  Item, ItemInput, Location, Page, Permission, SessionResponse,
} from "../packages/contracts/src/index.ts";
import type { Invoice, InvoiceInput } from "../packages/contracts/src/commerce.ts";
import type { InventorySettings } from "../packages/contracts/src/inventory.ts";

// Tests never inherit DATABASE_URL or write outside a disposable local schema.
const databaseUrl = process.env.ACCOUNT_ACTIVITY_STATISTICS_TEST_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const target = new URL(databaseUrl);
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "/workspace/.tools/postgresql/socket"]);
const hosts = [target.hostname, ...target.searchParams.getAll("host"), ...target.searchParams.getAll("hostaddr")].filter(Boolean);
assert(["postgres:", "postgresql:"].includes(target.protocol) && hosts.length > 0 && hosts.every((host) => localHosts.has(host)),
  "Account-activity tests require an explicitly local PostgreSQL target");
const origin = "http://localhost";
const password = "Local-activity-statistics-passphrase-2026";

class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private readonly baseUrl: string) {}
  async request<T>(method: string, path: string, body?: unknown) {
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET") {
      headers.set("content-type", "application/json"); headers.set("origin", origin);
      if (this.csrf) headers.set("x-csrf-token", this.csrf);
    }
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie()) this.cookie = value.split(";", 1)[0]!;
    const result: unknown = await response.json();
    if (result && typeof result === "object" && "csrf" in result) this.csrf = (result as SessionResponse).csrf;
    return { status: response.status, body: result as T };
  }
  async ok<T>(method: string, path: string, body?: unknown, status = 200) {
    const result = await this.request<T>(method, path, body);
    assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
}

async function fixture(t: TestContext) {
  const schema = `account_activity_${randomUUID().replaceAll("-", "")}`;
  let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: Server | undefined;
  t.after(async () => {
    try {
      if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      await runtime?.close();
    } finally {
      const cleanup = new Pool({ connectionString: databaseUrl });
      try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await cleanup.end(); }
    }
  });
  runtime = await createApp({ databaseUrl, schema, appOrigin: origin, production: false, serveStatic: false });
  server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const user = await provisionOwner(runtime.pool, {
    name: "Activity statistics owner", displayName: "Activity owner", email: "owner@account-activity.test", password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  const company = async (name = "Account activity company") =>
    (await owner.ok<{ company: Company }>("POST", "/companies", { name, phone: "", address: "" }, 201)).company;
  const member = async (companyId: number, permissions: Permission[]) => {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>("POST", "/auth/register", {
      name: "Activity employee", displayName: "Activity employee", email: `${randomUUID()}@account-activity.test`, phone: "", password,
    }, 201);
    assert(session.user);
    const employee = (await owner.ok<{ employee: Employee }>("POST", `/companies/${companyId}/employees`, {
      userId: session.user.id, name: "Activity employee", phone: "", role: "employee", active: true, permissions,
    }, 201)).employee;
    return { client, employee, user: session.user };
  };
  return { schema, pool: runtime.pool, owner, company, member };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setup(f: Fixture, name?: string) {
  const company = await f.company(name), base = `/companies/${company.id}`;
  const currencies = (await f.owner.ok<Page<CompanyCurrency>>("GET", `${base}/currencies`)).items;
  const yer = currencies.find((value) => value.code === "YER")!, usd = currencies.find((value) => value.code === "USD")!;
  const account = async (name: string, category: AccountCategory = "asset", cashOrBank = false) =>
    (await f.owner.ok<{ account: Account }>("POST", `${base}/accounts`, {
      name, parentId: null, kind: "posting", category, normalSide: category === "liability" ? "credit" : "debit", cashOrBank,
    }, 201)).account;
  const cash = await account("Activity cash", "asset", true);
  const customer = await account("Activity customer");
  const supplier = await account("Activity supplier", "liability");
  const secondSupplier = await account("Other activity supplier", "liability");
  const branch = (await f.owner.ok<Page<Branch>>("GET", `${base}/branches`)).items[0]!;
  const showroom = (await f.owner.ok<Page<Location>>("GET", `${base}/locations`)).items.find((value) => value.kind === "showroom")!;
  const settings = (await f.owner.ok<{ settings: InventorySettings }>("GET", `${base}/inventory-settings`)).settings;
  const item = async (overrides: Partial<ItemInput> = {}) =>
    (await f.owner.ok<{ item: Item }>("POST", `${base}/items`, {
      idempotencyKey: randomUUID(), name: "Activity source item", unit1Name: "unit", unit2Name: "unit", unit3Name: "unit",
      factor2: 1, factor3: 1, purchaseFactor: 1, salePrice1: "10", salePrice2: "10", salePrice3: "10",
      purchasePrice: "2", hasExpiry: false, currencyId: yer.id, ...overrides,
    }, 201)).item;
  const stats = async (accountId = customer.id, asOfDate = "2024-03-02", client = f.owner) =>
    (await client.ok<{ statistics: AccountBalanceStatistics }>("GET", `${base}/accounts/${accountId}/statistics?asOfDate=${asOfDate}`)).statistics;
  const invoiceBody = (kind: "sale" | "purchase", documentDate: string, lines: InvoiceInput["lines"], overrides: Partial<InvoiceInput> = {}): InvoiceInput => ({
    idempotencyKey: randomUUID(), kind, documentDate, currencyId: yer.id, branchId: branch.id, locationId: showroom.id,
    counterpartyAccountId: kind === "sale" ? customer.id : supplier.id,
    supplierAccountId: kind === "purchase" ? supplier.id : null, description: "Statistics invoice", discount: "0", lines, ...overrides,
  });
  const invoice = async (body: InvoiceInput) =>
    (await f.owner.ok<{ invoice: Invoice }>("POST", `${base}/invoices`, body, 201)).invoice;
  const draft = async (kind: "journal" | "payment" | "receipt", documentDate: string, amount: string, currencyId = yer.id) => {
    const debitAccount = kind === "receipt" ? cash : customer, creditAccount = kind === "receipt" ? customer : cash;
    return (await f.owner.ok<{ document: FinancialDocument }>("POST", `${base}/financial-documents`, {
      idempotencyKey: randomUUID(), kind, documentDate, currencyId, branchId: null,
      cashAccountId: kind === "journal" ? null : cash.id, description: "Statistics financial source",
      lines: [{ accountId: debitAccount.id, debit: amount, credit: "0" }, { accountId: creditAccount.id, debit: "0", credit: amount }],
    } satisfies FinancialDocumentInput, 201)).document;
  };
  const postDraft = async (document: FinancialDocument) =>
    (await f.owner.ok<{ document: FinancialDocument }>("POST", `${base}/financial-documents/${document.id}/post`, { revision: document.revision })).document;
  const post = async (kind: "journal" | "payment" | "receipt", date: string, amount: string, currencyId = yer.id) =>
    postDraft(await draft(kind, date, amount, currencyId));
  const reverse = async (document: FinancialDocument, documentDate: string) =>
    (await f.owner.ok<{ reversalDocument: FinancialDocument }>("POST", `${base}/financial-documents/${document.id}/reverse`, {
      idempotencyKey: randomUUID(), reason: "Dated activity correction", documentDate,
    })).reversalDocument;
  const flag = (key: string, enabled: boolean, revision: number | null = null) =>
    f.owner.ok<{ page: { revision: number } }>("PUT", `/page-catalog/${key}/settings`, {
      companyId: company.id, visible: true, enabled, order: 100, revision,
    });
  const deny = (employeeId: number, permissionKey: string) => f.owner.ok("PUT", `${base}/configuration/employee-rules`, {
    employeeId, permissionKey, effect: "deny", revision: null,
  });
  return { company, base, yer, usd, cash, customer, supplier, secondSupplier, settings, item, stats,
    invoiceBody, invoice, draft, postDraft, post, reverse, flag, deny };
}

async function humanActions(f: Fixture, companyId: number) {
  return (await f.pool.query<{ followups: string; approvals: string; audits: string }>(
    `SELECT (SELECT count(*)::text FROM account_balance_followups WHERE company_id=$1) AS followups,
      (SELECT count(*)::text FROM account_balance_approvals WHERE company_id=$1) AS approvals,
      (SELECT count(*)::text FROM audit_events WHERE company_id=$1) AS audits`, [companyId])).rows[0]!;
}

test("calendar windows include exact boundaries, Saturday, leap day, and exclude drafts and future documents", async (t) => {
  const f = await fixture(t), s = await setup(f);
  const sources = [
    ["2023-11-02", "1"], ["2023-11-03", "2"], ["2023-12-31", "4"],
    ["2024-01-01", "8"], ["2024-01-31", "16"], ["2024-02-01", "32"],
    ["2024-02-02", "64"], ["2024-02-03", "128"], ["2024-02-24", "256"],
    ["2024-02-25", "512"], ["2024-02-29", "1024"], ["2024-03-01", "2048"],
    ["2024-03-02", "4096"], ["2024-03-03", "8192"],
  ] as const;
  for (const [date, amount] of sources) await s.post("payment", date, amount);
  const draft = await s.draft("payment", "2024-03-01", "16384");
  const statistics = await s.stats(), { operations } = statistics;
  assert.deepEqual(operations.periods, {
    oneMonth: { from: "2024-02-03", to: "2024-03-02" },
    fourMonths: { from: "2023-11-03", to: "2024-03-02" },
    currentMonth: { from: "2024-03-01", to: "2024-03-02" },
    previousMonth: { from: "2024-02-01", to: "2024-02-29" },
    twoMonthsAgo: { from: "2024-01-01", to: "2024-01-31" },
    last30Days: { from: "2024-02-02", to: "2024-03-02" },
    last7Days: { from: "2024-02-25", to: "2024-03-02" },
    currentWeek: { from: "2024-03-02", to: "2024-03-02" },
  });
  assert(operations.payment && operations.activity);
  assert.equal(operations.payment.documentsAllTime, "13");
  assert.equal(operations.payment.documentsFourMonths, "12");
  assert.equal(operations.activity.documentsAllTime, "13");
  assert.deepEqual(operations.payment.totalsBase, { oneMonth: "8064", fourMonths: "8190", currentMonth: "6144",
    previousMonth: "2016", twoMonthsAgo: "24", last30Days: "8128", last7Days: "7680", currentWeek: "4096" });
  assert.equal(operations.payment.last?.documentDate, "2024-03-02");
  assert.equal((await s.stats(s.cash.id)).operations.payment?.documentsAllTime, "13", "A voucher is counted once for its cash side too");
  const before = await humanActions(f, s.company.id);
  assert.deepEqual((await s.stats()).operations, operations, "Repeated reads do not accumulate daily events");
  assert.deepEqual(await humanActions(f, s.company.id), before, "Derived reads never record follow-ups, approvals or audits");
  assert.equal((await s.stats(s.customer.id, "2024-03-01")).operations.payment?.documentsAllTime, "12");
  assert.equal((await s.stats()).operations.payment?.documentsAllTime, "13", "Changing the as-of date rebuilds the correct window");
  const posted = await s.postDraft(draft);
  const refreshed = await s.stats();
  assert.equal(refreshed.operations.payment?.documentsAllTime, "14");
  assert.equal(refreshed.operations.payment?.totalsBase.currentMonth, "22528");
  assert.equal(refreshed.components.activity?.state, "ready");
  assert.equal(refreshed.components.commerce?.state, "ready");
  assert.equal(refreshed.components.stock?.state, "ready");
  await f.owner.ok("POST", `${s.base}/financial-documents/${posted.id}/post`, { revision: draft.revision });
  assert.equal((await s.stats()).operations.payment?.documentsAllTime, "14", "A successful posting retry cannot duplicate activity");
});

test("voucher reversals keep original and correction events, signed period values and the latest eligible original", async (t) => {
  const f = await fixture(t), s = await setup(f);
  const oldReceipt = await s.post("receipt", "2024-01-01", "9007199254740993.25");
  const oldPayment = await s.post("payment", "2024-01-02", "3");
  await f.owner.ok("POST", `${s.base}/exchange-rates`, {
    currencyId: s.usd.id, rate: "100.125", effectiveAt: "2024-02-28T00:00:00Z", source: "Exact activity FX",
  }, 201);
  const receipt = await s.post("receipt", "2024-02-28", "0.04", s.usd.id);
  const payment = await s.post("payment", "2024-02-29", "7");
  const receiptReversal = await s.reverse(receipt, "2024-03-02");
  await s.reverse(payment, "2024-03-03");
  const before = (await s.stats(s.customer.id, "2024-03-01")).operations;
  assert.equal(before.receipt?.documentsAllTime, "2");
  assert.equal(before.payment?.documentsAllTime, "2");
  assert.equal(before.receipt?.last?.sourceId, receipt.id);
  assert.equal(before.receipt?.last?.amount, "0.04");
  assert.equal(before.receipt?.last?.baseAmount, "4.01");
  assert.equal(before.receipt?.last?.currency.code, "USD");
  assert.equal(before.receipt?.totalsBase.previousMonth, "4.01");
  const after = (await s.stats()).operations;
  assert.equal(after.receipt?.documentsAllTime, "3");
  assert.equal(after.receipt?.totalsBase.currentMonth, "-4.01");
  assert.equal(after.receipt?.totalsBase.fourMonths, "9007199254740993.25");
  assert.equal(after.receipt?.last?.sourceId, oldReceipt.id);
  assert.equal(after.receipt?.last?.amount, "9007199254740993.25");
  assert.equal(after.payment?.last?.sourceId, payment.id, "A reversal after the report date does not exclude the original early");
  assert.equal(after.activity?.last?.sourceId, receiptReversal.id);
  assert.equal(after.activity?.last?.sourceKind, "financial_document");
  assert.equal(after.activity?.last?.isCorrection, true);
  const final = (await s.stats(s.customer.id, "2024-03-03")).operations;
  assert.equal(final.payment?.documentsAllTime, "3");
  assert.equal(final.payment?.totalsBase.currentMonth, "-7");
  assert.equal(final.payment?.last?.sourceId, oldPayment.id);
  assert.equal(final.activity?.documentsAllTime, "6");
  await f.owner.ok("POST", `${s.base}/exchange-rates`, {
    currencyId: s.usd.id, rate: "999", effectiveAt: "2024-02-28T12:00:00Z", source: "Later FX cannot revalue activity",
  }, 201);
  assert.equal((await s.stats()).operations.receipt?.totalsBase.previousMonth, "4.01");
});

test("invoice events deduplicate linked journals, attribute purchases to the supplier, and include zero-net cash invoices", async (t) => {
  const f = await fixture(t), s = await setup(f), product = await s.item();
  const purchase = await s.invoice(s.invoiceBody("purchase", "2024-01-01", [{ itemId: product.id, unit: 1, quantity: "20", unitPrice: "2" }]));
  const saleBody = s.invoiceBody("sale", "2024-01-02", [{ itemId: product.id, unit: 1, quantity: "3" }]);
  const sale = await s.invoice(saleBody);
  assert(sale.financialDocumentId && sale.costDocumentId, "The sale fixture must actually contain two linked journals");
  assert.equal((await s.stats(s.customer.id, "2024-01-31")).operations.activity?.documentsAllTime, "1");
  const inventory = await s.stats(s.settings.inventoryAccountId!, "2024-01-31");
  assert.equal(inventory.operations.activity?.documentsAllTime, "2", "Inventory counts the two invoices, without counting their journals again");
  assert.equal((await s.stats(s.settings.cogsAccountId!, "2024-01-31")).operations.activity?.documentsAllTime, "1");
  const cashPurchase = await s.invoice(s.invoiceBody("purchase", "2024-01-03", [{ itemId: product.id, unit: 1, quantity: "2", unitPrice: "2" }], {
    counterpartyAccountId: s.cash.id, supplierAccountId: s.supplier.id,
  }));
  const supplier = await s.stats(s.supplier.id, "2024-01-31"), cash = await s.stats(s.cash.id, "2024-01-31");
  assert.equal(supplier.operations.purchase?.documentsAllTime, "2");
  assert.equal(supplier.operations.purchase?.totalsBase.currentMonth, "44");
  assert.equal(supplier.operations.purchase?.cashPurchasesFourMonthsBase, "4");
  assert.equal(supplier.balance.currentBase, "-40", "Cash procurement creates supplier activity without a supplier debt");
  assert.equal(cash.operations.activity?.documentsAllTime, "1");
  assert.equal(cash.operations.purchase?.documentsAllTime, "0", "The cashbox is not the actual supplier");
  assert.equal(cash.operations.payment?.documentsAllTime, "0", "A cash invoice is not a payment voucher");
  const freeProduct = await s.item({ name: "Free source item" });
  const beforeFree = await s.stats(s.supplier.id, "2024-01-31");
  const free = await s.invoice(s.invoiceBody("purchase", "2024-01-04", [{ itemId: freeProduct.id, unit: 1, quantity: "2", unitPrice: "0" }], {
    counterpartyAccountId: s.cash.id, supplierAccountId: s.supplier.id,
  }));
  assert.equal(free.financialDocumentId, null);
  const afterFree = await s.stats(s.supplier.id, "2024-01-31");
  assert.equal(afterFree.operations.purchase?.documentsAllTime, "3");
  assert.equal(afterFree.operations.activity?.documentsAllTime, "3");
  assert.equal(afterFree.operations.purchase?.last?.sourceId, free.id);
  assert.equal(afterFree.operations.purchase?.last?.amount, "0");
  assert.equal(afterFree.operations.purchase?.cashPurchasesFourMonthsBase, "4");
  assert.equal(afterFree.operations.purchase?.quality.cashClassificationUnknownFourMonths, "0");
  assert.deepEqual(afterFree.approvalQuote, beforeFree.approvalQuote,
    "A supplier-only zero invoice does not invalidate the unchanged financial balance quote");
  await f.owner.ok("POST", `${s.base}/accounts/${s.supplier.id}/balance-approvals`, {
    idempotencyKey: randomUUID(), ...beforeFree.approvalQuote,
  }, 201);
  const zeroSale = await s.invoice(s.invoiceBody("sale", "2024-01-05", [{ itemId: freeProduct.id, unit: 1, quantity: "1" }], { discount: "10" }));
  assert.equal(zeroSale.total, "0");
  const customer = await s.stats(s.customer.id, "2024-01-31");
  assert.equal(customer.operations.sale?.documentsAllTime, "2");
  assert.equal(customer.operations.sale?.last?.sourceId, zeroSale.id);
  assert.equal(customer.operations.sale?.last?.baseAmount, "0");
  assert.equal(customer.operations.activity?.documentsAllTime, "2");
  await s.invoice(s.invoiceBody("purchase", "2024-01-06", [{ itemId: freeProduct.id, unit: 1, quantity: "1", unitPrice: "0" }], {
    counterpartyAccountId: s.cash.id, supplierAccountId: null,
  }));
  const coverage = (await s.stats(s.supplier.id, "2024-01-31")).operations.purchase;
  assert.equal(coverage?.documentsAllTime, "3", "Unknown suppliers are not guessed from the current item card");
  assert.equal(coverage?.quality.companyUnknownSupplierDocumentsFourMonths, "1");
  assert.equal((await s.invoice(saleBody)).id, sale.id);
  assert.equal((await s.stats(s.customer.id, "2024-01-31")).operations.sale?.documentsAllTime, "2");
  assert.equal(purchase.supplierAccountId, cashPurchase.supplierAccountId);
});

test("mixed negative-net and zero-net invoices retain signed values while pure returns do not replace latest ordinary operations", async (t) => {
  const f = await fixture(t), s = await setup(f), product = await s.item();
  await s.invoice(s.invoiceBody("purchase", "2024-01-01", [{ itemId: product.id, unit: 1, quantity: "20", unitPrice: "10" }]));
  const mixedPurchase = await s.invoice(s.invoiceBody("purchase", "2024-01-02", [
    { itemId: product.id, unit: 1, quantity: "1", unitPrice: "5" },
    { itemId: product.id, unit: 1, quantity: "-2", unitPrice: "10" },
  ]));
  await s.invoice(s.invoiceBody("purchase", "2024-01-03", [{ itemId: product.id, unit: 1, quantity: "-1", unitPrice: "10" }]));
  const supplier = (await s.stats(s.supplier.id, "2024-01-03")).operations.purchase;
  assert.equal(supplier?.documentsAllTime, "3");
  assert.equal(supplier?.totalsBase.currentMonth, "175");
  assert.equal(supplier?.last?.sourceId, mixedPurchase.id);
  assert.equal(supplier?.last?.amount, "-15");
  await s.invoice(s.invoiceBody("sale", "2024-01-04", [{ itemId: product.id, unit: 1, quantity: "3" }]));
  const mixedSale = await s.invoice(s.invoiceBody("sale", "2024-01-05", [
    { itemId: product.id, unit: 1, quantity: "1" }, { itemId: product.id, unit: 1, quantity: "-3" },
  ]));
  const pureReturn = await s.invoice(s.invoiceBody("sale", "2024-01-06", [{ itemId: product.id, unit: 1, quantity: "-1" }]));
  const afterReturn = (await s.stats(s.customer.id, "2024-01-06")).operations;
  assert.equal(afterReturn.sale?.documentsAllTime, "3");
  assert.equal(afterReturn.sale?.totalsBase.currentMonth, "0");
  assert.equal(afterReturn.sale?.last?.sourceId, mixedSale.id);
  assert.equal(afterReturn.sale?.last?.amount, "-20");
  assert.equal(afterReturn.activity?.last?.sourceId, pureReturn.id);
  assert.equal(afterReturn.activity?.last?.isCorrection, true);
  const zero = await s.invoice(s.invoiceBody("sale", "2024-01-07", [
    { itemId: product.id, unit: 1, quantity: "1" }, { itemId: product.id, unit: 1, quantity: "-1" },
  ]));
  const afterZero = (await s.stats(s.customer.id, "2024-01-07")).operations.sale;
  assert.equal(afterZero?.documentsAllTime, "4");
  assert.equal(afterZero?.totalsBase.currentMonth, "0");
  assert.equal(afterZero?.last?.sourceId, zero.id);
  assert.equal(afterZero?.last?.amount, "0");
  const original = await s.invoice(s.invoiceBody("purchase", "2024-01-08", [{ itemId: product.id, unit: 1, quantity: "1", unitPrice: "2" }], {
    counterpartyAccountId: s.cash.id, supplierAccountId: s.supplier.id,
  }));
  await s.invoice(s.invoiceBody("purchase", "2024-01-09", [{ itemId: product.id, unit: 1, quantity: "-1", originalLineId: original.lines[0]!.id }], {
    counterpartyAccountId: s.cash.id, supplierAccountId: s.secondSupplier.id,
  }));
  const conflict = (await s.stats(s.secondSupplier.id, "2024-01-31")).operations.purchase;
  assert.equal(conflict?.documentsAllTime, "1");
  assert.equal(conflict?.totalsBase.currentMonth, "-2");
  assert.equal(conflict?.cashPurchasesFourMonthsBase, "-2");
  assert.equal(conflict?.quality.supplierConflictsFourMonths, "1");
  assert.equal(conflict?.last, null, "A pure linked return does not become an ordinary purchase");
});

test("family permissions redact values, source references and metadata without changing authorized balances", async (t) => {
  const f = await fixture(t), s = await setup(f), other = await setup(f, "Foreign activity company");
  const product = await s.item();
  await s.invoice(s.invoiceBody("purchase", "2024-01-01", [{ itemId: product.id, unit: 1, quantity: "2", unitPrice: "2" }]));
  await s.invoice(s.invoiceBody("sale", "2024-01-02", [{ itemId: product.id, unit: 1, quantity: "1" }]));
  await s.post("receipt", "2024-01-03", "2");
  const baseGrants: Permission[] = ["accounts.view", "finance.view"];
  const financial = await f.member(s.company.id, baseGrants);
  const full = await f.member(s.company.id, [...baseGrants, "commerce.view"]);
  const foreign = await f.member(other.company.id, [...baseGrants, "commerce.view"]);
  const owner = await s.stats(s.customer.id, "2024-01-31");
  const limited = await s.stats(s.customer.id, "2024-01-31", financial.client);
  assert.equal(limited.balance.currentBase, owner.balance.currentBase);
  assert.equal(limited.operations.availability.sale, false);
  assert.equal(limited.operations.availability.purchase, false);
  assert.equal(limited.operations.availability.purchaseCash, false);
  assert.equal(limited.operations.availability.payment, true);
  assert.equal(limited.operations.availability.receipt, true);
  assert.equal(limited.operations.availability.activity, false);
  assert.equal(limited.operations.sale, null);
  assert.equal(limited.operations.purchase, null);
  assert.equal(limited.operations.activity, null);
  assert.equal(limited.components.activity, null);
  assert.equal(limited.components.commerce, null);
  assert.equal((await s.stats(s.customer.id, "2024-01-31", full.client)).operations.activity?.documentsAllTime, "2");
  await s.deny(full.employee.id, "company.sales:view");
  const deniedSale = await s.stats(s.customer.id, "2024-01-31", full.client);
  assert.equal(deniedSale.operations.sale, null);
  assert.equal(deniedSale.operations.availability.sale, false);
  assert(deniedSale.operations.purchase);
  assert.equal(deniedSale.operations.activity, null);
  assert.equal(deniedSale.components.commerce, null);
  const noInvoice = await f.member(s.company.id, [...baseGrants, "commerce.view"]);
  await s.deny(noInvoice.employee.id, "company.invoice:view");
  const invoiceDenied = await s.stats(s.customer.id, "2024-01-31", noInvoice.client);
  assert.equal(invoiceDenied.operations.sale, null);
  assert.equal(invoiceDenied.operations.purchase, null);
  for (const key of ["company.sales", "company.purchases", "company.payments", "company.receipts"])
    await s.flag(key, false);
  const hidden = await s.stats(s.customer.id, "2024-01-31");
  assert.equal(hidden.balance.currentBase, owner.balance.currentBase);
  for (const family of ["sale", "purchase", "payment", "receipt", "activity"] as const) {
    assert.equal(hidden.operations.availability[family], false);
    assert.equal(hidden.operations[family], null);
  }
  assert.equal(hidden.components.activity, null);
  assert.equal(hidden.components.commerce, null);
  assert.equal(hidden.components.stock?.state, "ready");
  assert.equal((await foreign.client.request("GET", `${s.base}/accounts/${s.customer.id}/statistics?asOfDate=2024-01-31`)).status, 403);
  assert.equal((await f.owner.request("GET", `${s.base}/accounts/${other.customer.id}/statistics?asOfDate=2024-01-31`)).status, 404);
});

test("financial-only reset clears derived daily activity and later posting starts current totals without losing human history", async (t) => {
  const f = await fixture(t), s = await setup(f);
  await s.post("payment", "2024-01-01", "7");
  const before = await s.stats(s.customer.id, "2024-01-31");
  await f.owner.ok("POST", `${s.base}/accounts/${s.customer.id}/balance-followups`, { idempotencyKey: randomUUID(), note: "Preserve activity-independent history" }, 201);
  const preview = await f.owner.ok<{ snapshotHash: string; companyName: string; blockers: string[] }>("GET", `${s.base}/transaction-reset`);
  assert.deepEqual(preview.blockers, []);
  await f.owner.ok("POST", `${s.base}/transaction-reset`, { idempotencyKey: randomUUID(), snapshotHash: preview.snapshotHash,
    confirmationCompanyName: preview.companyName, deleteAllTransactions: true });
  const after = await s.stats(s.customer.id, "2024-01-31");
  assert.notEqual(after.sourceGeneration, before.sourceGeneration);
  assert.equal(after.operations.activity?.documentsAllTime, "0");
  assert.equal(after.operations.payment?.documentsAllTime, "0");
  assert.equal(after.operations.payment?.totalsBase.currentMonth, "0");
  assert.equal(after.operations.activity?.last, null);
  assert.equal(after.operations.payment?.last, null);
  assert(after.lastFollowUp);
  await s.post("payment", "2024-01-02", "3");
  const latest = await s.stats(s.customer.id, "2024-01-31");
  assert.equal(latest.operations.payment?.documentsAllTime, "1");
  assert.equal(latest.operations.payment?.totalsBase.currentMonth, "3");
});

test("invoice reset removes invoice-derived counters and cached references for the actual supplier and financial accounts", async (t) => {
  const f = await fixture(t), s = await setup(f), product = await s.item();
  await s.invoice(s.invoiceBody("purchase", "2024-01-01", [{ itemId: product.id, unit: 1, quantity: "2", unitPrice: "2" }], {
    counterpartyAccountId: s.cash.id, supplierAccountId: s.supplier.id,
  }));
  await s.invoice(s.invoiceBody("sale", "2024-01-02", [{ itemId: product.id, unit: 1, quantity: "1" }]));
  for (const accountId of [s.supplier.id, s.cash.id, s.customer.id, s.settings.inventoryAccountId!]) await s.stats(accountId, "2024-01-31");
  const preview = await f.owner.ok<{ snapshotHash: string; companyName: string; blockers: string[] }>("GET", `${s.base}/transaction-reset`);
  assert.deepEqual(preview.blockers, []);
  await f.owner.ok("POST", `${s.base}/transaction-reset`, { idempotencyKey: randomUUID(), snapshotHash: preview.snapshotHash,
    confirmationCompanyName: preview.companyName, deleteAllTransactions: true });
  for (const accountId of [s.supplier.id, s.cash.id, s.customer.id, s.settings.inventoryAccountId!]) {
    const statistics = await s.stats(accountId, "2024-01-31");
    assert.equal(statistics.operations.activity?.documentsAllTime, "0");
    assert.equal(statistics.operations.activity?.last, null);
    assert.equal(statistics.operations.purchase?.documentsAllTime, "0");
    assert.equal(statistics.operations.sale?.documentsAllTime, "0");
  }
});
