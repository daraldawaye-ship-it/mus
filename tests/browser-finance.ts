import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { Pool } from "pg";
import {
  chromium,
  request,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Account,
  AccountBalance,
  AccountLedgerLine,
  AccountLedgerTotals,
  Branch,
  Company,
  CompanyCurrency,
  Employee,
  FinancialDocument,
  Location,
  Page as ApiPage,
  SessionResponse,
  User,
} from "../packages/contracts/src/index.ts";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql:///tijara?host=%2Fworkspace%2F.tools%2Fpostgresql%2Fsocket&port=55432&user=agent";
const schema = `browser_finance_${process.pid}_${Date.now()}`;
const password = "Finance-browser-password-2026";
const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    assert(address && typeof address === "object");
    probe.close(() => resolve(address.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
interface Actor {
  context: APIRequestContext;
  session: SessionResponse;
}
const contexts: BrowserContext[] = [];
const apiContexts: APIRequestContext[] = [];
const failures: string[] = [];
const pageErrors: string[] = [];
let browser: Browser | undefined;
let server: Server | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let passed = 0;

async function call<T>(
  actor: Actor,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await actor.context.fetch(`/api${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(actor.session.csrf ? { "x-csrf-token": actor.session.csrf } : {}),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  const result: unknown = await response.json();
  assert(
    response.ok(),
    `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`,
  );
  return result as T;
}
async function actorFor(
  email: string,
  context?: APIRequestContext,
): Promise<Actor> {
  const actor: Actor = {
    context: context ?? (await request.newContext({ baseURL: origin })),
    session: { user: null, csrf: null },
  };
  if (!context) apiContexts.push(actor.context);
  actor.session = await call<SessionResponse>(actor, "/auth/login", "POST", {
    email,
    password,
  });
  assert(actor.session.user);
  return actor;
}
async function pageFor(email = "owner@finance.browser.test", mobile = false) {
  assert(browser);
  const context = await browser.newContext({
    baseURL: origin,
    timezoneId: "UTC",
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 960 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  context.setDefaultTimeout(10000);
  contexts.push(context);
  const actor = await actorFor(email, context.request);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { page, actor, context };
}
async function scenario(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`, error);
    const page = contexts.at(-1)?.pages().at(-1);
    if (page && !page.isClosed()) {
      console.error(`Failure page: ${page.url()}`);
      await page
        .screenshot({
          path: `/tmp/tijara-finance-failure-${failures.length}.png`,
          fullPage: true,
        })
        .catch(() => {});
    }
  }
}
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => void,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  do {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  throw lastError;
}
async function selectLookup(
  page: Page,
  container: Page | Locator,
  label: string,
  query: string,
  accountId: number,
) {
  const response = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.searchParams.get("q") === query &&
      response.ok()
    );
  });
  await container.getByLabel(`بحث عن ${label}`, { exact: true }).fill(query);
  await response;
  const select = container.getByLabel(label, { exact: true });
  await select
    .locator(`option[value="${accountId}"]`)
    .waitFor({ state: "attached" });
  await select.selectOption(String(accountId));
}
async function pick(
  page: Page,
  button: Locator,
  label: string,
  query: string,
  id: number,
) {
  await button.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await selectLookup(page, dialog, label, query, id);
  await dialog.waitFor({ state: "hidden" });
}
function pickerButton(page: Page, label: string) {
  return page
    .locator(".field")
    .filter({ has: page.getByText(label, { exact: true }) })
    .getByRole("button")
    .first();
}
async function responseDocument(
  page: Page,
  path: string,
  method: string,
  action: () => Promise<void>,
) {
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api${path}` &&
      response.request().method() === method,
  );
  await action();
  const result = await response;
  const body = (await result.json()) as {
    document: FinancialDocument;
    reversalDocument?: FinancialDocument;
  };
  assert(
    result.ok(),
    `${method} ${path}: ${result.status()} ${JSON.stringify(body)}`,
  );
  return body;
}
async function saveDocument(page: Page, base: string, id?: number) {
  const result = await responseDocument(
    page,
    `${base}/financial-documents${id ? `/${id}` : ""}`,
    id ? "PATCH" : "POST",
    () =>
      page.getByRole("button", { name: "حفظ المسودة", exact: true }).click(),
  );
  await page.waitForURL(
    `${origin}${base}/financial-documents/${result.document.id}`,
  );
  await page.getByLabel("البيان العام", { exact: true }).waitFor();
  return result.document;
}
async function postDocument(page: Page, base: string, id: number) {
  await page
    .getByRole("button", { name: "ترحيل المستند", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const result = await responseDocument(
    page,
    `${base}/financial-documents/${id}/post`,
    "POST",
    () => dialog.getByRole("button", { name: "تأكيد", exact: true }).click(),
  );
  await dialog.waitFor({ state: "hidden" });
  assert.equal(result.document.status, "posted");
  await eventually(
    () => page.getByLabel("البيان العام", { exact: true }).isDisabled(),
    (disabled) => assert(disabled),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "حفظ المسودة", exact: true })
      .count(),
    0,
  );
  return result.document;
}
async function assertViewport(page: Page, width: number) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    direction: getComputedStyle(document.documentElement).direction,
  }));
  assert.equal(dimensions.width, width);
  assert.equal(dimensions.direction, "rtl");
  assert(
    dimensions.html <= width + 1,
    `Page must not overflow horizontally: ${JSON.stringify(dimensions)}`,
  );
  assert(
    dimensions.body <= width + 1,
    `Body must not overflow horizontally: ${JSON.stringify(dimensions)}`,
  );
}
function cents(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  assert(match, `Unexpected monetary value ${value}`);
  return (
    (match[1] ? -1n : 1n) *
    (BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0")))
  );
}

try {
  app = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: true,
  });
  await provisionOwner(app.pool, {
    name: "Finance Browser Owner",
    displayName: "Finance Browser Owner",
    email: "owner@finance.browser.test",
    password,
  });
  server = app.app.listen(port, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const owner = await actorFor("owner@finance.browser.test");
  const companyA = (
    await call<{ company: Company }>(owner, "/companies", "POST", {
      name: "شركة مراجعة المحاسبة",
      phone: "+967700001101",
      address: "صنعاء",
    })
  ).company;
  const companyB = (
    await call<{ company: Company }>(owner, "/companies", "POST", {
      name: "شركة أخرى معزولة",
      phone: "+967700001102",
      address: "عدن",
    })
  ).company;
  const base = `/companies/${companyA.id}`;
  await call(owner, `${base}/accounts/initialize`, "POST", {});
  await call(owner, `${base}/currencies/initialize`, "POST", {
    baseCurrency: "YER",
  });
  const accounts = (
    await call<ApiPage<Account>>(owner, `${base}/accounts?pageSize=100`)
  ).items;
  const currencies = (
    await call<ApiPage<CompanyCurrency>>(
      owner,
      `${base}/currencies?pageSize=100`,
    )
  ).items;
  const currency = currencies.find((value) => value.code === "YER")!;
  const revenue = accounts.find((value) => value.code === "4100000001")!;
  const expense = accounts.find((value) => value.code === "5200000001")!;
  const cashParent = accounts.find((value) => value.code === "1111000000")!;
  assert(currency && revenue && expense && cashParent);
  const cash = (
    await call<{ account: Account }>(owner, `${base}/accounts`, "POST", {
      parentId: cashParent.id,
      name: "صندوق الاختبار",
      kind: "posting",
      category: "asset",
      normalSide: "debit",
      active: true,
      cashOrBank: true,
      rangeStart: null,
      rangeEnd: null,
    })
  ).account;
  const registration: Actor = {
    context: await request.newContext({ baseURL: origin }),
    session: { user: null, csrf: null },
  };
  apiContexts.push(registration.context);
  const reader = (
    await call<SessionResponse>(registration, "/auth/register", "POST", {
      name: "Finance Reader",
      displayName: "Finance Reader",
      email: "reader@finance.browser.test",
      phone: "+967700001103",
      password,
    })
  ).user!;
  await call<{ employee: Employee }>(owner, `${base}/employees`, "POST", {
    userId: reader.id,
    name: "قارئ الحسابات",
    phone: reader.phone,
    role: "accountant",
    active: true,
    permissions: ["finance.view"],
  });

  await scenario(
    "company creation atomically provides main branch and showroom for financial forms",
    async () => {
      const branches = await call<ApiPage<Branch>>(owner, `${base}/branches`);
      assert.equal(branches.total, 1);
      assert.equal(branches.items[0]!.code, "HQ");
      const locations = await call<ApiPage<Location>>(
        owner,
        `${base}/locations`,
      );
      assert.equal(locations.total, 1);
      assert.equal(locations.items[0]!.kind, "showroom");
      assert.equal(locations.items[0]!.branchId, branches.items[0]!.id);
      assert(locations.items[0]!.effectiveActive);
    },
  );

  const ownerView = await pageFor();
  const page = ownerView.page;
  let journal: FinancialDocument | undefined;
  let receipt: FinancialDocument | undefined;
  let payment: FinancialDocument | undefined;

  await scenario(
    "journal UI saves a balanced draft, updates its revision and posts immutable exact amounts",
    async () => {
      await page.goto(`${base}/journals`);
      await page
        .getByRole("heading", { name: "قيود اليومية", exact: true })
        .waitFor();
      await page
        .getByRole("link", { name: "إضافة قيد يومية", exact: true })
        .click();
      await page
        .getByLabel("تاريخ المستند", { exact: true })
        .fill("2026-10-11");
      await pick(
        page,
        page.getByRole("button", { name: "اختر العملة", exact: true }),
        "العملة",
        "YER",
        currency.id,
      );
      const mainBranch = (
        await call<ApiPage<Branch>>(owner, `${base}/branches`)
      ).items[0]!;
      await pick(
        page,
        pickerButton(page, "الفرع — اختياري"),
        "الفرع",
        "HQ",
        mainBranch.id,
      );
      await pick(
        page,
        page.getByRole("button", { name: "اختيار حساب السطر 1", exact: true }),
        "الحساب",
        cash.code,
        cash.id,
      );
      await pick(
        page,
        page.getByRole("button", { name: "اختيار حساب السطر 2", exact: true }),
        "الحساب",
        revenue.code,
        revenue.id,
      );
      await page.getByLabel("مدين السطر 1", { exact: true }).fill("100.25");
      await page.getByLabel("دائن السطر 2", { exact: true }).fill("100.25");
      await page
        .getByLabel("البيان العام", { exact: true })
        .fill("قيد اختبار المتصفح");
      journal = await saveDocument(page, base);
      assert.equal(journal.status, "draft");
      assert.equal(journal.branchId, mainBranch.id);
      assert.equal(cents(journal.totalDebit), 10025n);
      const before = await call<ApiPage<AccountBalance>>(
        owner,
        `${base}/account-balances?q=${cash.code}`,
      );
      assert.equal(
        cents(
          before.items.find((item) => item.accountId === cash.id)?.balance ??
            "0",
        ),
        0n,
        "Draft must not change balances",
      );
      const originalRevision = journal.revision;
      await page.getByLabel("مدين السطر 1", { exact: true }).fill("100.50");
      await page.getByLabel("دائن السطر 2", { exact: true }).fill("100.50");
      await page
        .getByLabel("البيان العام", { exact: true })
        .fill("قيد محدث قبل الترحيل");
      journal = await saveDocument(page, base, journal.id);
      assert(journal.revision > originalRevision);
      assert.equal(journal.description, "قيد محدث قبل الترحيل");
      assert.equal(cents(journal.totalDebit), 10050n);
      journal = await postDocument(page, base, journal.id);
      assert.equal(journal.exchangeRate, "1");
      assert.equal(cents(journal.totalBaseDebit!), 10050n);
      assert.equal(
        await page.getByLabel("مدين السطر 1", { exact: true }).isDisabled(),
        true,
      );
      await page.screenshot({
        path: "/tmp/tijara-finance-journal-desktop.png",
        fullPage: true,
      });
    },
  );

  await scenario(
    "receipt UI restricts cash choices and posts cash debit with counterparty credit",
    async () => {
      await page.goto(`${base}/receipts`);
      await page
        .getByRole("link", { name: "إضافة سند قبض", exact: true })
        .click();
      await page
        .getByLabel("تاريخ المستند", { exact: true })
        .fill("2026-10-11");
      await pick(
        page,
        page.getByRole("button", { name: "اختر العملة", exact: true }),
        "العملة",
        "YER",
        currency.id,
      );
      await pickerButton(page, "حساب الصندوق أو البنك").click();
      const dialog = page.getByRole("dialog");
      await eventually(
        () =>
          dialog.getByLabel("الصندوق أو البنك", { exact: true }).isDisabled(),
        (disabled) => assert.equal(disabled, false),
      );
      const cashOptions = await dialog
        .getByLabel("الصندوق أو البنك", { exact: true })
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        );
      assert(cashOptions.includes(String(cash.id)));
      assert(
        !cashOptions.includes(String(revenue.id)),
        "Revenue must not appear among cash accounts",
      );
      assert(
        !cashOptions.includes(String(expense.id)),
        "Expense must not appear among cash accounts",
      );
      await selectLookup(page, dialog, "الصندوق أو البنك", cash.code, cash.id);
      await dialog.waitFor({ state: "hidden" });
      await pick(
        page,
        pickerButton(page, "الحساب المقبوض منه"),
        "الحساب",
        revenue.code,
        revenue.id,
      );
      await page.getByLabel("المبلغ (YER)", { exact: true }).fill("10.25");
      await page
        .getByLabel("البيان العام", { exact: true })
        .fill("قبض اختبار المتصفح");
      receipt = await saveDocument(page, base);
      assert.equal(receipt.kind, "receipt");
      assert.equal(receipt.cashAccountId, cash.id);
      const cashLine = receipt.lines.find(
        (line) => line.accountId === cash.id,
      )!;
      const counterparty = receipt.lines.find(
        (line) => line.accountId === revenue.id,
      )!;
      assert.equal(cents(cashLine.debit), 1025n);
      assert.equal(cents(cashLine.credit), 0n);
      assert.equal(cents(counterparty.credit), 1025n);
      receipt = await postDocument(page, base, receipt.id);
      assert.equal(
        await page
          .getByRole("table", { name: "سطور السند المرحل", exact: true })
          .count(),
        1,
      );
    },
  );

  await scenario(
    "payment UI posts cash credit with expense debit and preserves decimal cents",
    async () => {
      await page.goto(`${base}/payments`);
      await page
        .getByRole("link", { name: "إضافة سند صرف", exact: true })
        .click();
      await page
        .getByLabel("تاريخ المستند", { exact: true })
        .fill("2026-10-11");
      await pick(
        page,
        page.getByRole("button", { name: "اختر العملة", exact: true }),
        "العملة",
        "YER",
        currency.id,
      );
      await pick(
        page,
        pickerButton(page, "حساب الصندوق أو البنك"),
        "الصندوق أو البنك",
        cash.code,
        cash.id,
      );
      await pick(
        page,
        pickerButton(page, "الحساب المصروف إليه"),
        "الحساب",
        expense.code,
        expense.id,
      );
      await page.getByLabel("المبلغ (YER)", { exact: true }).fill("7.10");
      await page
        .getByLabel("البيان العام", { exact: true })
        .fill("صرف اختبار المتصفح");
      payment = await saveDocument(page, base);
      assert.equal(payment.kind, "payment");
      const cashLine = payment.lines.find(
        (line) => line.accountId === cash.id,
      )!;
      const counterparty = payment.lines.find(
        (line) => line.accountId === expense.id,
      )!;
      assert.equal(cents(cashLine.credit), 710n);
      assert.equal(cents(cashLine.debit), 0n);
      assert.equal(cents(counterparty.debit), 710n);
      payment = await postDocument(page, base, payment.id);
    },
  );

  await scenario(
    "balance and ledger screens include posted documents and an auditable UI reversal",
    async () => {
      assert(
        journal && receipt && payment,
        "Document UI scenarios must finish first",
      );
      await page.goto(`${base}/account-balances?q=${cash.code}`);
      await page
        .getByRole("heading", { name: "أرصدة الحسابات", exact: true })
        .waitFor();
      const cashRow = page.locator("tbody tr").filter({ hasText: cash.code });
      await cashRow.getByText("103.65 مدين", { exact: true }).waitFor();
      await cashRow
        .getByRole("link", { name: "عرض الكشف", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "كشف حساب", exact: true })
        .waitFor();
      await page
        .locator(".financial-totals")
        .getByText("103.65 مدين", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("table", { name: "حركات كشف الحساب", exact: true })
          .locator("tbody tr[data-row-id]")
          .count(),
        3,
      );
      await page.goto(`${base}/financial-documents/${journal.id}`);
      await page
        .getByRole("button", { name: "عكس المستند", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      assert.equal(
        await dialog
          .getByRole("button", { name: "تأكيد", exact: true })
          .isDisabled(),
        true,
        "Reversal requires a reason",
      );
      await dialog
        .getByLabel("تاريخ القيد العكسي", { exact: true })
        .fill("2026-10-11");
      await dialog
        .getByLabel("سبب العكس", { exact: true })
        .fill("تصحيح قيد اختبار المتصفح");
      const reversed = await responseDocument(
        page,
        `${base}/financial-documents/${journal.id}/reverse`,
        "POST",
        () =>
          dialog.getByRole("button", { name: "تأكيد", exact: true }).click(),
      );
      await dialog.waitFor({ state: "hidden" });
      assert.equal(reversed.document.status, "reversed");
      assert(reversed.reversalDocument);
      assert.equal(reversed.reversalDocument.reversesDocumentId, journal.id);
      assert.equal(cents(reversed.reversalDocument.totalDebit), 10050n);
      await page
        .getByRole("link", { name: "القيد العكسي", exact: true })
        .waitFor();
      journal = reversed.document;
      await page.goto(`${base}/account-ledger?accountId=${cash.id}`);
      await page
        .locator(".financial-totals")
        .getByText("3.15 مدين", { exact: true })
        .waitFor();
      await page
        .getByRole("table", { name: "حركات كشف الحساب", exact: true })
        .getByText("قيد عكسي", { exact: true })
        .waitFor();
      const ledger = await call<
        ApiPage<AccountLedgerLine> & { totals: AccountLedgerTotals }
      >(owner, `${base}/account-ledger?accountId=${cash.id}`);
      assert.equal(ledger.total, 4);
      assert.equal(cents(ledger.totals.closingBalance), 315n);
      assert.equal(cents(ledger.items.at(-1)!.runningBalance), 315n);
      await page.goto(`${base}/account-balances?q=${cash.code}`);
      await page
        .locator("tbody tr")
        .filter({ hasText: cash.code })
        .getByText("3.15 مدين", { exact: true })
        .waitFor();
    },
  );

  await scenario(
    "an unbalanced journal is saved as a draft but posting fails without changing balances or its saved input",
    async () => {
      const before = await call<ApiPage<FinancialDocument>>(
        owner,
        `${base}/financial-documents`,
      );
      await page.goto(`${base}/financial-documents/new?kind=journal`);
      await pick(
        page,
        page.getByRole("button", { name: "اختر العملة", exact: true }),
        "العملة",
        "YER",
        currency.id,
      );
      await pick(
        page,
        page.getByRole("button", { name: "اختيار حساب السطر 1", exact: true }),
        "الحساب",
        cash.code,
        cash.id,
      );
      await pick(
        page,
        page.getByRole("button", { name: "اختيار حساب السطر 2", exact: true }),
        "الحساب",
        revenue.code,
        revenue.id,
      );
      await page.getByLabel("مدين السطر 1", { exact: true }).fill("12.50");
      await page.getByLabel("دائن السطر 2", { exact: true }).fill("12.49");
      await page
        .getByLabel("البيان العام", { exact: true })
        .fill("مسودة غير متوازنة محفوظة في الحقول");
      const draft = await saveDocument(page, base);
      assert.equal(draft.status, "draft");
      assert.equal(cents(draft.totalDebit), 1250n);
      assert.equal(cents(draft.totalCredit), 1249n);
      await page
        .getByRole("button", { name: "ترحيل المستند", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      const rejected = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api${base}/financial-documents/${draft.id}/post` &&
          response.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "تأكيد", exact: true }).click();
      const response = await rejected;
      assert.equal(response.status(), 400);
      const rejection = (await response.json()) as {
        error: { code: string; message: string };
      };
      assert.equal(rejection.error.code, "unbalanced_entry");
      await dialog
        .getByText(rejection.error.message, { exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: "إلغاء", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await page.getByLabel("مدين السطر 1", { exact: true }).inputValue(),
        "12.5",
      );
      assert.equal(
        await page.getByLabel("دائن السطر 2", { exact: true }).inputValue(),
        "12.49",
      );
      assert.equal(
        await page.getByLabel("البيان العام", { exact: true }).inputValue(),
        "مسودة غير متوازنة محفوظة في الحقول",
      );
      assert.equal(
        (
          await call<ApiPage<FinancialDocument>>(
            owner,
            `${base}/financial-documents`,
          )
        ).total,
        before.total + 1,
      );
      const persisted = (
        await call<{ document: FinancialDocument }>(
          owner,
          `${base}/financial-documents/${draft.id}`,
        )
      ).document;
      assert.equal(persisted.status, "draft");
      assert.equal(cents(persisted.totalDebit), 1250n);
      const balance = await call<ApiPage<AccountBalance>>(
        owner,
        `${base}/account-balances?q=${cash.code}`,
      );
      assert.equal(
        cents(
          balance.items.find((item) => item.accountId === cash.id)!.balance,
        ),
        315n,
      );
    },
  );

  await scenario(
    "unsaved journal changes block sidebar and browser-back navigation until the user explicitly leaves",
    async () => {
      await page.goto(`${base}/journals`);
      await page
        .getByRole("link", { name: "إضافة قيد يومية", exact: true })
        .click();
      const draftPath = `${base}/financial-documents/new`;
      await page
        .getByLabel("البيان العام", { exact: true })
        .fill("مسودة محفوظة أثناء التنقل");
      await page.locator(`.sidebar a[href="${base}/account-balances"]`).click();
      const dialog = page.getByRole("dialog", {
        name: "مغادرة المستند",
        exact: true,
      });
      await dialog.waitFor();
      assert.equal(new URL(page.url()).pathname, draftPath);
      await dialog
        .getByRole("button", { name: "البقاء في المستند", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await page.getByLabel("البيان العام", { exact: true }).inputValue(),
        "مسودة محفوظة أثناء التنقل",
      );
      await page.goBack();
      await dialog.waitFor();
      assert.equal(new URL(page.url()).pathname, draftPath);
      await dialog
        .getByRole("button", { name: "البقاء في المستند", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await page.getByLabel("البيان العام", { exact: true }).inputValue(),
        "مسودة محفوظة أثناء التنقل",
      );
      await page.locator(`.sidebar a[href="${base}/account-balances"]`).click();
      await dialog
        .getByRole("button", { name: "مغادرة دون حفظ", exact: true })
        .click();
      await page.waitForURL(`${origin}${base}/account-balances`);
      await page
        .getByRole("heading", { name: "أرصدة الحسابات", exact: true })
        .waitFor();
    },
  );

  await scenario(
    "a committed creation with lost acknowledgement freezes fields and retries the exact same request without a duplicate",
    async () => {
      await page.goto(`${base}/financial-documents/new?kind=journal`);
      await pick(
        page,
        page.getByRole("button", { name: "اختر العملة", exact: true }),
        "العملة",
        "YER",
        currency.id,
      );
      await pick(
        page,
        page.getByRole("button", { name: "اختيار حساب السطر 1", exact: true }),
        "الحساب",
        cash.code,
        cash.id,
      );
      await pick(
        page,
        page.getByRole("button", { name: "اختيار حساب السطر 2", exact: true }),
        "الحساب",
        revenue.code,
        revenue.id,
      );
      await page.getByLabel("مدين السطر 1", { exact: true }).fill("33.25");
      await page.getByLabel("دائن السطر 2", { exact: true }).fill("33.25");
      await page
        .getByLabel("البيان العام", { exact: true })
        .fill("مسودة إعادة المحاولة الآمنة");
      const before = await call<ApiPage<FinancialDocument>>(
        owner,
        `${base}/financial-documents`,
      );
      let originalBody: unknown;
      let committed: FinancialDocument | undefined;
      await page.route(
        `**/api${base}/financial-documents`,
        async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          originalBody = route.request().postDataJSON() as unknown;
          const actual = await route.fetch();
          assert(actual.ok());
          committed = ((await actual.json()) as { document: FinancialDocument })
            .document;
          await route.abort("failed");
        },
        { times: 1 },
      );
      await page
        .getByRole("button", { name: "حفظ المسودة", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: "إعادة إرسال طلب الحفظ نفسه",
          exact: true,
        })
        .waitFor();
      assert(committed);
      assert.equal(
        await page.getByLabel("البيان العام", { exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByLabel("مدين السطر 1", { exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByLabel("دائن السطر 2", { exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        (
          await call<ApiPage<FinancialDocument>>(
            owner,
            `${base}/financial-documents`,
          )
        ).total,
        before.total + 1,
        "Server committed only one draft before retry",
      );
      const retryRequest = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname ===
            `/api${base}/financial-documents` && request.method() === "POST",
      );
      const result = await responseDocument(
        page,
        `${base}/financial-documents`,
        "POST",
        () =>
          page
            .getByRole("button", {
              name: "إعادة إرسال طلب الحفظ نفسه",
              exact: true,
            })
            .click(),
      );
      assert.deepEqual(
        (await retryRequest).postDataJSON() as unknown,
        originalBody,
        "Retry must reuse both original body and UUID",
      );
      assert.equal(result.document.id, committed.id);
      await page.waitForURL(
        `${origin}${base}/financial-documents/${committed.id}`,
      );
      await page.getByLabel("البيان العام", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("البيان العام", { exact: true }).isDisabled(),
        false,
      );
      assert.equal(
        (
          await call<ApiPage<FinancialDocument>>(
            owner,
            `${base}/financial-documents`,
          )
        ).total,
        before.total + 1,
        "Retry must not create a duplicate",
      );
    },
  );

  await scenario(
    "finance-view employee reads vouchers and balances while create, edit, post and reverse controls stay unavailable",
    async () => {
      assert(receipt);
      const view = await pageFor("reader@finance.browser.test");
      await view.page.goto(`${base}/receipts`);
      await view.page
        .getByRole("heading", { name: "سندات القبض", exact: true })
        .waitFor();
      await view.page
        .getByRole("link", { name: receipt.number, exact: true })
        .waitFor();
      assert.equal(
        await view.page
          .getByRole("link", { name: "إضافة سند قبض", exact: true })
          .count(),
        0,
      );
      await view.page
        .getByRole("link", { name: receipt.number, exact: true })
        .click();
      await view.page.getByLabel("البيان العام", { exact: true }).waitFor();
      assert.equal(
        await view.page
          .getByLabel("البيان العام", { exact: true })
          .isDisabled(),
        true,
      );
      for (const name of ["حفظ المسودة", "ترحيل المستند", "عكس المستند"])
        assert.equal(
          await view.page.getByRole("button", { name, exact: true }).count(),
          0,
        );
      await view.page.goto(`${base}/financial-documents/new?kind=receipt`);
      await view.page
        .getByText("لا تملك الصلاحية المطلوبة لفتح هذه الصفحة.", { exact: true })
        .waitFor();
      assert.equal(
        await view.page.getByLabel("البيان العام", { exact: true }).count(),
        0,
      );
      await view.page.goto(`${base}/account-balances?q=${cash.code}`);
      await view.page
        .locator("tbody tr")
        .filter({ hasText: cash.code })
        .getByText("3.15 مدين", { exact: true })
        .waitFor();
      await view.page
        .locator("tbody tr")
        .filter({ hasText: cash.code })
        .getByRole("link", { name: "عرض الكشف", exact: true })
        .click();
      await view.page
        .locator(".financial-totals")
        .getByText("3.15 مدين", { exact: true })
        .waitFor();
      assert.equal(
        await view.page.locator(`.sidebar a[href="${base}/accounts"]`).count(),
        0,
        "Financial read permission must not expose master-data administration",
      );
    },
  );

  await scenario(
    "financial documents remain compact RTL in dark mode and print with white backgrounds and company identification",
    async () => {
      assert(receipt);
      await call(ownerView.actor, "/appearance", "PATCH", {
        scope: `company:${companyA.id}`,
        mode: "dark",
        color: "#6d28d9",
      });
      await page.goto(`${base}/financial-documents/${receipt.id}`);
      await page.getByLabel("البيان العام", { exact: true }).waitFor();
      await eventually(
        () => page.locator("html").getAttribute("data-theme"),
        (mode) => assert.equal(mode, "dark"),
      );
      await assertViewport(page, 1440);
      const field = await page
        .getByLabel("البيان العام", { exact: true })
        .evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          font: getComputedStyle(element).fontSize,
        }));
      assert.equal(field.height, 32);
      assert.equal(field.font, "14px");
      assert.equal(
        await page
          .locator(".topbar")
          .evaluate((element) => element.getBoundingClientRect().height),
        36,
      );
      assert.equal(await page.locator(".scope-title small").count(), 0);
      await page.screenshot({
        path: "/tmp/tijara-finance-receipt-dark.png",
        fullPage: true,
      });
      await page.emulateMedia({ media: "print" });
      const print = await page.evaluate(() => ({
        header: getComputedStyle(
          document.querySelector(".financial-print-heading")!,
        ).display,
        heading: document.querySelector(".financial-print-heading")!
          .textContent,
        sidebar: getComputedStyle(document.querySelector(".sidebar")!).display,
        topbar: getComputedStyle(document.querySelector(".topbar")!).display,
        card: getComputedStyle(document.querySelector(".financial-document")!)
          .backgroundColor,
        controls: getComputedStyle(
          document.querySelector(".financial-document-actions")!,
        ).display,
      }));
      assert.notEqual(print.header, "none");
      assert(print.heading?.includes(companyA.name));
      assert.equal(print.sidebar, "none");
      assert.equal(print.topbar, "none");
      assert.equal(print.controls, "none");
      assert.equal(print.card, "rgb(255, 255, 255)");
      await page.screenshot({
        path: "/tmp/tijara-finance-print.png",
        fullPage: true,
      });
      await page.emulateMedia({ media: "screen" });
    },
  );

  await scenario(
    "mobile journals, vouchers, balances and ledger keep readable fields and horizontal scrolling inside tables",
    async () => {
      assert(journal && receipt && payment);
      const mobile = await pageFor("owner@finance.browser.test", true);
      for (const route of [
        `financial-documents/${journal.id}`,
        `financial-documents/${receipt.id}`,
        `financial-documents/${payment.id}`,
        "account-balances",
        `account-ledger?accountId=${cash.id}`,
      ]) {
        await mobile.page.goto(`${base}/${route}`);
        if (route.startsWith("financial-documents")) {
          await mobile.page
            .getByLabel("البيان العام", { exact: true })
            .waitFor();
          const field = await mobile.page
            .getByLabel("البيان العام", { exact: true })
            .evaluate((element) => ({
              height: element.getBoundingClientRect().height,
              font: getComputedStyle(element).fontSize,
            }));
          assert.equal(field.height, 38);
          assert.equal(field.font, "14px");
        } else
          await mobile.page
            .getByRole("heading", {
              name:
                route === "account-balances" ? "أرصدة الحسابات" : "كشف حساب",
              exact: true,
            })
            .waitFor();
        await assertViewport(mobile.page, 390);
        assert.equal(
          await mobile.page
            .locator(".topbar")
            .evaluate((element) => element.getBoundingClientRect().height),
          44,
        );
        assert.equal(
          await mobile.page.locator(".scope-title small").count(),
          0,
        );
      }
      await mobile.page.goto(`${base}/financial-documents/${receipt.id}`);
      await mobile.page.getByLabel("البيان العام", { exact: true }).waitFor();
      await mobile.page.screenshot({
        path: "/tmp/tijara-finance-mobile.png",
        fullPage: true,
      });
    },
  );

  await scenario(
    "late financial-list response cannot expose the previous company after SPA navigation",
    async () => {
      let started!: () => void;
      let release!: () => void;
      const incoming = new Promise<void>((resolve) => {
        started = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.goto(`${base}/account-balances`);
      await page
        .getByRole("heading", { name: "أرصدة الحسابات", exact: true })
        .waitFor();
      await page.route(
        `**/api${base}/financial-documents?**`,
        async (route) => {
          const actual = await route.fetch();
          started();
          await released;
          await route.fulfill({ response: actual }).catch(() => {});
        },
      );
      const navigate = async (path: string) =>
        page.evaluate((path) => {
          window.history.pushState(
            {
              ...window.history.state,
              idx: (window.history.state?.idx ?? 0) + 1,
            },
            "",
            path,
          );
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, path);
      await navigate(`${base}/journals?q=محدث`);
      await incoming;
      await navigate(`/companies/${companyB.id}/journals`);
      await page
        .locator(".scope-title strong")
        .getByText(companyB.name, { exact: true })
        .waitFor();
      await page
        .getByRole("heading", { name: "قيود اليومية", exact: true })
        .waitFor();
      release();
      await eventually(
        () => page.locator("tbody tr[data-row-id]").count(),
        (count) => assert.equal(count, 0),
      );
      assert.equal(
        await page.getByText("قيد محدث قبل الترحيل", { exact: true }).count(),
        0,
      );
      assert.equal(
        new URL(page.url()).pathname,
        `/companies/${companyB.id}/journals`,
      );
      const isolated = await call<ApiPage<FinancialDocument>>(
        owner,
        `/companies/${companyB.id}/financial-documents`,
      );
      assert.equal(isolated.total, 0);
      await page.unroute(`**/api${base}/financial-documents?**`);
    },
  );

  assert.equal(
    pageErrors.length,
    0,
    `Unexpected browser errors: ${pageErrors.join("; ")}`,
  );
} finally {
  for (const context of contexts) await context.close();
  for (const context of apiContexts) await context.dispose();
  await browser?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  await app?.close();
  const cleanup = new Pool({ connectionString: databaseUrl });
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await cleanup.end();
  }
}
console.log(
  `Finance browser scenarios: ${passed} passed, ${failures.length} failed`,
);
assert(passed > 0, "No browser scenarios executed");
assert.equal(
  failures.length,
  0,
  `Failed finance browser scenarios: ${failures.join(", ")}`,
);
