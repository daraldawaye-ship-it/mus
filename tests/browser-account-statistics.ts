import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Account,
  AccountBalanceFollowUp,
  AccountBalanceStatistics,
  Company,
  CompanyCurrency,
  FinancialDocument,
  Page as ApiPage,
  SessionResponse,
} from "../packages/contracts/src/index.ts";

// Never inherit the application's DATABASE_URL. This real-app browser review
// may connect only to local PostgreSQL and creates a disposable test schema.
const databaseUrl =
  process.env.ACCOUNT_STATISTICS_BROWSER_TEST_DATABASE_URL ??
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
  "Account-statistics browser tests require an explicitly local PostgreSQL target",
);
const schema = `browser_account_statistics_${randomUUID().replaceAll("-", "")}`;
const email = "owner@account-statistics.browser.test";
const password = "Local-account-statistics-browser-passphrase-2026";
const reportDate = "2025-03-01";
const prefix = "اختبار إحصاءات";
const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    assert(address && typeof address === "object");
    probe.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
const origin = `http://127.0.0.1:${port}`;
interface Actor {
  context: APIRequestContext;
  session: SessionResponse;
}
const apiContexts: APIRequestContext[] = [];
const browserContexts: BrowserContext[] = [];
const pageErrors: string[] = [];
const failures: string[] = [];
let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
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
async function actorFor(address = email) {
  const context = await request.newContext({ baseURL: origin });
  apiContexts.push(context);
  const actor: Actor = { context, session: { user: null, csrf: null } };
  actor.session = await call<SessionResponse>(actor, "/auth/login", "POST", {
    email: address,
    password,
  });
  assert(actor.session.user);
  return actor;
}
async function pageFor(actor: Actor, mobile = false) {
  assert(browser);
  const context = await browser.newContext({
    baseURL: origin,
    storageState: await actor.context.storageState(),
    timezoneId: "Asia/Aden",
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 960 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  context.setDefaultTimeout(15000);
  browserContexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return page;
}
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => void,
  timeout = 15000,
) {
  const end = Date.now() + timeout;
  let lastError: unknown;
  do {
    try {
      const value = await read();
      check(value);
      return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < end);
  throw lastError;
}
async function scenario(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`, error);
    const page = browserContexts.at(-1)?.pages().at(-1);
    if (page && !page.isClosed()) {
      await page
        .screenshot({
          path: `work/account-statistics-browser-failure-${failures.length}.png`,
          fullPage: true,
        })
        .catch(() => {});
    }
  }
}
function table(page: Page) {
  return page.getByRole("table", { name: "إحصاءات الحسابات", exact: true });
}
function card(page: Page) {
  return page.getByRole("dialog").filter({
    has: page.getByRole("heading", {
      name: "إحصاءات الحساب ومتابعة الرصيد",
      exact: true,
    }),
  });
}
function detail(container: Locator, label: string) {
  return container
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("xpath=following-sibling::dd[1]");
}
async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    window.history.pushState(
      { ...window.history.state, idx: (window.history.state?.idx ?? 0) + 1 },
      "",
      path,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}
async function ready(page: Page) {
  await page
    .getByRole("heading", { name: "إحصاءات الحسابات", exact: true })
    .waitFor();
  await table(page).waitFor();
  await eventually(
    () => table(page).locator("..").locator("..").getAttribute("aria-busy"),
    (value) => assert.notEqual(value, "true"),
  );
}
async function openCard(page: Page, account: Account) {
  await page
    .getByRole("button", {
      name: `إحصاءات الحساب ${account.code}`,
      exact: true,
    })
    .click();
  await card(page).waitFor();
  await detail(card(page), "الرصيد حتى تاريخ التقرير").waitFor();
}
async function geometry(
  page: Page,
  width: number,
  field: Locator,
  height: number,
) {
  const actual = await page.evaluate(() => ({
    direction: getComputedStyle(document.documentElement).direction,
    width: innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.equal(actual.direction, "rtl");
  assert.equal(actual.width, width);
  assert(
    actual.html <= width + 1 && actual.body <= width + 1,
    JSON.stringify(actual),
  );
  const input = await field.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    font: getComputedStyle(element).fontSize,
  }));
  assert.equal(input.height, height);
  assert.equal(input.font, "14px");
}

try {
  await mkdir("work", { recursive: true });
  runtime = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: true,
  });
  await provisionOwner(runtime.pool, {
    name: "Statistics browser owner",
    displayName: "Statistics browser owner",
    email,
    password,
  });
  server = runtime.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const owner = await actorFor();
  const company = (
    await call<{ company: Company }>(owner, "/companies", "POST", {
      name: "شركة مراجعة إحصاءات الحسابات",
      phone: "",
      address: "عدن",
    })
  ).company;
  const otherCompany = (
    await call<{ company: Company }>(owner, "/companies", "POST", {
      name: "شركة إحصاءات أخرى معزولة",
      phone: "",
      address: "عدن",
    })
  ).company;
  const base = `/companies/${company.id}`;
  const reportPath = `${base}/account-statistics`;
  const currency = (
    await call<ApiPage<CompanyCurrency>>(owner, `${base}/currencies`)
  ).items.find((row) => row.code === "YER")!;
  assert(currency);
  const account = async (name: string, active = true, companyId = company.id) =>
    (
      await call<{ account: Account }>(
        owner,
        `/companies/${companyId}/accounts`,
        "POST",
        {
          name,
          parentId: null,
          kind: "posting",
          category: "asset",
          normalSide: "debit",
          cashOrBank: false,
          active,
        },
      )
    ).account;
  const alpha = await account(`${prefix} ألفا`);
  const beta = await account(`${prefix} باء`);
  const negative = await account(`${prefix} دائن`);
  const counterpart = await account("المقابل المحاسبي للإحصاءات");
  const archived = await account(`${prefix} مؤرشف`, false);
  for (let index = 1; index <= 12; index++)
    await account(`${prefix} إضافي ${String(index).padStart(2, "0")}`);
  const isolatedAccount = await account(
    "حساب خاص بالشركة الثانية",
    true,
    otherCompany.id,
  );
  const post = async (
    debitAccount: Account,
    creditAccount: Account,
    amount: string,
  ) => {
    const draft = (
      await call<{ document: FinancialDocument }>(
        owner,
        `${base}/financial-documents`,
        "POST",
        {
          idempotencyKey: randomUUID(),
          kind: "journal",
          documentDate: "2024-01-01",
          currencyId: currency.id,
          branchId: null,
          cashAccountId: null,
          description: "مصدر اختبار إحصاءات المتصفح",
          lines: [
            { accountId: debitAccount.id, debit: amount, credit: "0" },
            { accountId: creditAccount.id, debit: "0", credit: amount },
          ],
        },
      )
    ).document;
    return (
      await call<{ document: FinancialDocument }>(
        owner,
        `${base}/financial-documents/${draft.id}/post`,
        "POST",
        { revision: draft.revision },
      )
    ).document;
  };
  await post(alpha, counterpart, "90071992547409.91");
  await post(beta, counterpart, "90071992547409.92");
  await post(counterpart, negative, "10.25");
  const stats = async (accountId = alpha.id) =>
    (
      await call<{ statistics: AccountBalanceStatistics }>(
        owner,
        `${base}/accounts/${accountId}/statistics?asOfDate=${reportDate}`,
      )
    ).statistics;
  const counts = async () => {
    assert(runtime);
    return (
      await runtime.pool.query<{ followups: string; approvals: string }>(
        "SELECT (SELECT count(*)::text FROM account_balance_followups WHERE company_id=$1) AS followups,(SELECT count(*)::text FROM account_balance_approvals WHERE company_id=$1) AS approvals",
        [company.id],
      )
    ).rows[0]!;
  };
  const flag = async (enabled: boolean, revision: number | null = null) =>
    (
      await call<{ page: { revision: number } }>(
        owner,
        "/page-catalog/company.account-statistics/settings",
        "PUT",
        {
          companyId: company.id,
          visible: true,
          enabled,
          order: 100,
          revision,
        },
      )
    ).page.revision;
  const page = await pageFor(owner);

  await scenario(
    "report search, exact signed sorting, multi-sort and pagination preserve URL navigation",
    async () => {
      await page.goto(`${reportPath}?asOfDate=${reportDate}&pageSize=10`);
      await ready(page);
      const search = page.getByLabel("بحث في الحسابات", { exact: true });
      await search.fill(prefix);
      await search.press("Enter");
      await eventually(
        async () => new URL(page.url()).searchParams.get("q"),
        (value) => assert.equal(value, prefix),
      );
      await eventually(
        () => table(page).locator("tbody tr[data-row-id]").count(),
        (count) => assert.equal(count, 10),
      );
      const amountHeader = table(page).locator(
        'th[data-column-id="balanceOneYearAgoBase"]',
      );
      await amountHeader.getByRole("button").click();
      await eventually(
        () =>
          table(page)
            .locator("tbody tr[data-row-id]")
            .first()
            .getAttribute("data-row-id"),
        (value) => assert.equal(value, String(negative.id)),
      );
      await amountHeader.getByRole("button").click();
      await eventually(
        () =>
          table(page)
            .locator("tbody tr[data-row-id]")
            .first()
            .getAttribute("data-row-id"),
        (value) => assert.equal(value, String(beta.id)),
      );
      const ordered = await table(page)
        .locator("tbody tr[data-row-id]")
        .evaluateAll((rows) =>
          rows.slice(0, 2).map((row) => row.getAttribute("data-row-id")),
        );
      assert.deepEqual(
        ordered,
        [String(beta.id), String(alpha.id)],
        "Adjacent large exact amounts must not collapse to a floating-point tie",
      );
      const firstAmount = await table(page)
        .locator(
          `tr[data-row-id="${beta.id}"] td[data-cell-id="balanceOneYearAgoBase"]`,
        )
        .innerText();
      assert(firstAmount.includes("90,071,992,547,409.92"), firstAmount);
      await table(page)
        .locator('th[data-column-id="name"]')
        .getByRole("button")
        .click({ modifiers: ["Shift"] });
      await eventually(
        async () => ({
          amountPriority: await amountHeader.getAttribute("data-sort-priority"),
          namePriority: await table(page)
            .locator('th[data-column-id="name"]')
            .getAttribute("data-sort-priority"),
          sort: new URL(page.url()).searchParams.get("sort"),
        }),
        (value) =>
          assert.deepEqual(value, {
            amountPriority: "1",
            namePriority: "2",
            sort: "balanceOneYearAgoBase:desc,name:asc",
          }),
      );
      const sortedUrl = page.url();
      await page
        .getByRole("button", { name: "الصفحة التالية", exact: true })
        .click();
      await eventually(
        async () => new URL(page.url()).searchParams.get("page"),
        (value) => assert.equal(value, "2"),
      );
      await page.goBack();
      await eventually(
        async () => page.url(),
        (value) => assert.equal(value, sortedUrl),
      );
      await page
        .getByLabel("حالة الحساب", { exact: true })
        .selectOption("archived");
      await eventually(
        () =>
          table(page)
            .locator("tbody tr[data-row-id]")
            .evaluateAll((rows) =>
              rows.map((row) => row.getAttribute("data-row-id")),
            ),
        (value) => assert.deepEqual(value, [String(archived.id)]),
      );
      assert.equal(new URL(page.url()).searchParams.has("page"), false);
      await page
        .getByLabel("حالة الحساب", { exact: true })
        .selectOption("active");
      await page
        .getByLabel("مجموعة الإحصاءات", { exact: true })
        .selectOption("periods");
      await page
        .getByLabel("الفترة", { exact: true })
        .selectOption("currentWeek");
      await table(page)
        .locator('th[data-column-id="paymentsCurrentWeekBase"]')
        .waitFor();
      await eventually(
        () => page.locator("body").innerText(),
        (value) => assert(value.includes("السبت")),
      );
    },
  );

  await scenario(
    "opening report and account cards records no events; explicit follow-up remains independent of approval",
    async () => {
      const before = await counts();
      await page.goto(
        `${reportPath}?q=${encodeURIComponent(alpha.code)}&asOfDate=${reportDate}`,
      );
      await ready(page);
      const opener = page.getByRole("button", {
        name: `إحصاءات الحساب ${alpha.code}`,
        exact: true,
      });
      await opener.focus();
      await page.keyboard.press("Enter");
      await detail(card(page), "آخر متابعة مسجّلة للرصيد").waitFor();
      assert.equal(
        (
          await detail(card(page), "آخر متابعة مسجّلة للرصيد").innerText()
        ).trim(),
        "لم تسجّل متابعة بعد",
      );
      assert.deepEqual(
        await counts(),
        before,
        "GET report and card must not manufacture human events",
      );
      await card(page)
        .getByLabel("ملاحظة المتابعة أو الاعتماد", { exact: true })
        .fill("متابعة فعلية من المتصفح");
      await card(page)
        .getByRole("button", { name: "تسجيل متابعة الرصيد", exact: true })
        .click();
      await card(page)
        .getByText("تم تسجيل متابعة الرصيد.", { exact: true })
        .waitFor();
      await eventually(
        () => detail(card(page), "آخر متابعة مسجّلة للرصيد").innerText(),
        (value) => assert(value.includes("متابعة فعلية من المتصفح")),
      );
      assert.equal((await counts()).approvals, before.approvals);
      assert.equal(
        (await counts()).followups,
        String(BigInt(before.followups) + 1n),
      );
      assert.equal(
        await card(page)
          .getByRole("button", { name: "اعتماد الرصيد المعروض", exact: true })
          .isDisabled(),
        true,
      );
      await card(page)
        .getByLabel("ملاحظة المتابعة أو الاعتماد", { exact: true })
        .fill("اعتماد مستقل للرصيد المعروض");
      await card(page)
        .getByRole("checkbox", { name: /أؤكد مراجعة الرصيد المعروض/ })
        .check();
      await card(page)
        .getByRole("button", { name: "اعتماد الرصيد المعروض", exact: true })
        .click();
      await card(page)
        .getByText("تم اعتماد الرصيد المعروض.", { exact: true })
        .waitFor();
      await eventually(
        () => detail(card(page), "آخر رصيد معتمد").innerText(),
        (value) => assert(value.includes("اعتماد مستقل للرصيد المعروض")),
      );
      assert.equal(
        (await counts()).followups,
        String(BigInt(before.followups) + 1n),
      );
      assert.equal(
        (await counts()).approvals,
        String(BigInt(before.approvals) + 1n),
      );
      await page.keyboard.press("Escape");
      await card(page).waitFor({ state: "detached" });
      assert.equal(new URL(page.url()).searchParams.has("accountId"), false);
      assert.equal(
        await opener.evaluate((element) => element === document.activeElement),
        true,
        "Escape restores keyboard focus to the card opener",
      );
      await page.goto(`${base}/accounts?q=${alpha.code}`);
      await page
        .getByRole("table", { name: "دليل الحسابات", exact: true })
        .waitFor();
      await openCard(page, alpha);
      assert(
        (
          await detail(card(page), "آخر متابعة مسجّلة للرصيد").innerText()
        ).includes("متابعة فعلية من المتصفح"),
      );
      await card(page)
        .getByRole("button", { name: "إغلاق النافذة", exact: true })
        .click();
    },
  );

  await scenario(
    "changed ledger rejects the old approval quote and requires a fresh explicit confirmation",
    async () => {
      await page.goto(
        `${reportPath}?q=${alpha.code}&accountId=${alpha.id}&asOfDate=${reportDate}`,
      );
      await detail(card(page), "الرصيد حتى تاريخ التقرير").waitFor();
      const before = await counts();
      const oldQuote = (await stats()).approvalQuote;
      await card(page)
        .getByRole("checkbox", { name: /أؤكد مراجعة الرصيد المعروض/ })
        .check();
      await post(alpha, counterpart, "0.01");
      const rejected = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith(
            `/accounts/${alpha.id}/balance-approvals`,
          ) && response.request().method() === "POST",
      );
      await card(page)
        .getByRole("button", { name: "اعتماد الرصيد المعروض", exact: true })
        .click();
      assert.equal((await rejected).status(), 409);
      await card(page)
        .getByText(
          "تغيّر الرصيد أو مصدره. راجع الرصيد المحدّث ثم أكّد الاعتماد من جديد.",
          { exact: true },
        )
        .waitFor();
      await eventually(
        () =>
          card(page)
            .getByRole("checkbox", { name: /أؤكد مراجعة الرصيد المعروض/ })
            .isChecked(),
        (checked) => assert.equal(checked, false),
      );
      assert.equal(
        await card(page)
          .getByRole("button", { name: "اعتماد الرصيد المعروض", exact: true })
          .isDisabled(),
        true,
      );
      assert.deepEqual(
        await counts(),
        before,
        "A stale quote must not save or automatically submit a new quote",
      );
      await eventually(
        () => detail(card(page), "الرصيد حتى تاريخ التقرير").innerText(),
        (value) => assert(value.includes("90,071,992,547,409.92")),
      );
      await card(page)
        .getByRole("checkbox", { name: /أؤكد مراجعة الرصيد المعروض/ })
        .check();
      const accepted = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname.endsWith(
            `/accounts/${alpha.id}/balance-approvals`,
          ) && request.method() === "POST",
      );
      await card(page)
        .getByRole("button", { name: "اعتماد الرصيد المعروض", exact: true })
        .click();
      const acceptedBody = (await accepted).postDataJSON() as {
        expectedSourceRevision: string;
        expectedBalanceBase: string;
      };
      assert.notEqual(
        acceptedBody.expectedSourceRevision,
        oldQuote.expectedSourceRevision,
      );
      assert.equal(acceptedBody.expectedBalanceBase, "90071992547409.92");
      await card(page)
        .getByText("تم اعتماد الرصيد المعروض.", { exact: true })
        .waitFor();
      assert.equal(
        (await counts()).approvals,
        String(BigInt(before.approvals) + 1n),
      );
    },
  );

  await scenario(
    "committed response loss preserves the same actor/account payload and confirms once after a page flag change",
    async () => {
      await page.goto(
        `${reportPath}?q=${beta.code}&accountId=${beta.id}&asOfDate=${reportDate}`,
      );
      await detail(card(page), "آخر متابعة مسجّلة للرصيد").waitFor();
      const before = await counts();
      const path = `/api${base}/accounts/${beta.id}/balance-followups`;
      let frozen: unknown;
      let committed: AccountBalanceFollowUp | undefined;
      await card(page)
        .getByLabel("ملاحظة المتابعة أو الاعتماد", { exact: true })
        .fill("نتيجة محفوظة قبل انقطاع الرد");
      await page.route(
        `**${path}`,
        async (route) => {
          frozen = route.request().postDataJSON();
          const actual = await route.fetch();
          assert.equal(actual.status(), 201);
          committed = (
            (await actual.json()) as { followUp: AccountBalanceFollowUp }
          ).followUp;
          await route.abort("failed");
        },
        { times: 1 },
      );
      await card(page)
        .getByRole("button", { name: "تسجيل متابعة الرصيد", exact: true })
        .click();
      await card(page)
        .getByRole("button", { name: "إعادة الطلب نفسه", exact: true })
        .waitFor();
      assert(committed);
      assert.equal(
        await card(page)
          .getByLabel("ملاحظة المتابعة أو الاعتماد", { exact: true })
          .count(),
        0,
        "An uncertain request must not expose an editable replacement payload",
      );
      assert.equal(
        (await counts()).followups,
        String(BigInt(before.followups) + 1n),
      );
      await page.keyboard.press("Escape");
      await card(page).waitFor({ state: "detached" });
      await page
        .getByRole("button", {
          name: `إحصاءات الحساب ${beta.code}`,
          exact: true,
        })
        .click();
      await card(page)
        .getByRole("button", { name: "إعادة الطلب نفسه", exact: true })
        .waitFor();
      assert(
        (await card(page).innerText()).includes("نتيجة محفوظة قبل انقطاع الرد"),
      );
      const disabledRevision = await flag(false);
      try {
        const retryRequest = page.waitForRequest(
          (request) =>
            new URL(request.url()).pathname === path &&
            request.method() === "POST",
        );
        const retryResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === path &&
            response.request().method() === "POST",
        );
        await card(page)
          .getByRole("button", { name: "إعادة الطلب نفسه", exact: true })
          .click();
        assert.deepEqual(
          (await retryRequest).postDataJSON(),
          frozen,
          "Retry must retain the exact original UUID and payload",
        );
        const response = await retryResponse;
        assert.equal(response.status(), 201);
        assert.equal(
          ((await response.json()) as { followUp: AccountBalanceFollowUp })
            .followUp.id,
          committed.id,
        );
        await card(page)
          .getByText("تم تسجيل متابعة الرصيد.", { exact: true })
          .waitFor();
        assert.equal(
          (await counts()).followups,
          String(BigInt(before.followups) + 1n),
        );
      } finally {
        await flag(true, disabledRevision);
      }
    },
  );

  await scenario(
    "ordinary readers can open account statistics while optional sources and actions stay restricted",
    async () => {
      const registrationContext = await request.newContext({ baseURL: origin });
      apiContexts.push(registrationContext);
      const registration: Actor = {
        context: registrationContext,
        session: { user: null, csrf: null },
      };
      const readerEmail = "reader@account-statistics.browser.test";
      const registered = await call<SessionResponse>(
        registration,
        "/auth/register",
        "POST",
        {
          name: "Statistics browser reader",
          displayName: "Statistics browser reader",
          email: readerEmail,
          phone: "",
          password,
        },
      );
      assert(registered.user);
      await call(owner, `${base}/employees`, "POST", {
        userId: registered.user.id,
        name: "قارئ إحصاءات",
        phone: "",
        role: "employee",
        active: true,
        permissions: ["accounts.view", "finance.view"],
      });
      const reader = await actorFor(readerEmail);
      const readerPage = await pageFor(reader);
      await readerPage.goto(
        `${reportPath}?q=${alpha.code}&asOfDate=${reportDate}`,
      );
      await ready(readerPage);
      await readerPage
        .getByLabel("مجموعة الإحصاءات", { exact: true })
        .selectOption("stock");
      await table(readerPage)
        .locator(`tr[data-row-id="${alpha.id}"]`)
        .getByText("غير متاح", { exact: true })
        .waitFor();
      await openCard(readerPage, alpha);
      assert.equal(
        await card(readerPage)
          .getByRole("button", { name: "تسجيل متابعة الرصيد", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await card(readerPage)
          .getByRole("button", { name: "اعتماد الرصيد المعروض", exact: true })
          .count(),
        0,
      );
      assert.equal(
        (
          await detail(
            card(readerPage),
            "قيمة الأصناف المرتبطة بالحساب — حالية",
          ).innerText()
        ).trim(),
        "غير متاحة بالصلاحيات الحالية",
      );
      await card(readerPage)
        .getByLabel("مجموعة مؤشرات الحساب", { exact: true })
        .selectOption("activity");
      await detail(card(readerPage), "عدد الحركات منذ البداية")
        .getByText("غير متاح بالصلاحيات الحالية", { exact: true })
        .waitFor();
      await card(readerPage)
        .getByRole("button", { name: "إغلاق النافذة", exact: true })
        .click();
      await readerPage.goto(`${base}/accounts?q=${alpha.code}`);
      await readerPage
        .getByRole("button", {
          name: `إحصاءات الحساب ${alpha.code}`,
          exact: true,
        })
        .waitFor();
      assert.equal(
        await readerPage
          .getByRole("button", {
            name: `تعديل الحساب ${alpha.code}`,
            exact: true,
          })
          .count(),
        0,
      );
    },
  );

  await scenario(
    "delayed report and card responses cannot replace another company's current state",
    async () => {
      await page.goto(`${reportPath}?q=${alpha.code}&asOfDate=${reportDate}`);
      await ready(page);
      let started!: () => void;
      let release!: () => void;
      const incoming = new Promise<void>((resolve) => {
        started = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const routePattern = `**/api${base}/account-statistics-report?**`;
      await page.route(
        routePattern,
        async (route) => {
          const actual = await route.fetch();
          started();
          await released;
          await route.fulfill({ response: actual }).catch(() => {});
        },
        { times: 1 },
      );
      try {
        // PageHeader consolidates multiple actions in the "الإجراءات"
        // menu. Refresh must be invoked from that visible menu.
        await page.getByRole("button", { name: "الإجراءات", exact: true }).click();
        await page.getByRole("menu", { name: "إجراءات الصفحة" })
          .getByRole("menuitem", { name: "تحديث التقرير", exact: true }).click();
        // If the UI no longer initiates an HTTP refresh, fail with a
        // diagnostic rather than hanging this CI job indefinitely.
        await Promise.race([
          incoming,
          new Promise<void>((_, reject) => setTimeout(
            () => reject(new Error("Refreshing the account report did not issue a report request")),
            12000,
          )),
        ]);
        await navigate(
          page,
          `/companies/${otherCompany.id}/account-statistics?q=${isolatedAccount.code}`,
        );
        await ready(page);
        await table(page)
          .locator(`tr[data-row-id="${isolatedAccount.id}"]`)
          .waitFor();
        release();
        await eventually(
          () => table(page).locator(`tr[data-row-id="${alpha.id}"]`).count(),
          (value) => assert.equal(value, 0),
        );
        assert.equal(
          new URL(page.url()).pathname,
          `/companies/${otherCompany.id}/account-statistics`,
        );
        assert.equal(
          await page.getByText(alpha.name, { exact: true }).count(),
          0,
        );
        await openCard(page, isolatedAccount);
        assert.equal(
          (
            await detail(card(page), "آخر متابعة مسجّلة للرصيد").innerText()
          ).trim(),
          "لم تسجّل متابعة بعد",
        );
        assert.equal(
          await card(page)
            .getByText("متابعة فعلية من المتصفح", { exact: true })
            .count(),
          0,
        );
        await card(page)
          .getByRole("button", { name: "إغلاق النافذة", exact: true })
          .click();
      } finally {
        release();
        await page.unroute(routePattern);
      }
    },
  );

  await scenario(
    "desktop and mobile report/card keep compact RTL fields, dark theme and keyboard access",
    async () => {
      await call(owner, "/appearance", "PATCH", {
        scope: `company:${company.id}`,
        mode: "dark",
        color: "#6d28d9",
      });
      await page.goto(`${reportPath}?q=${alpha.code}&asOfDate=${reportDate}`);
      await ready(page);
      await eventually(
        () => page.locator("html").getAttribute("data-theme"),
        (value) => assert.equal(value, "dark"),
      );
      await geometry(
        page,
        1440,
        page.getByLabel("بحث في الحسابات", { exact: true }),
        32,
      );
      await page.screenshot({
        path: "work/account-statistics-browser-desktop-dark.png",
        fullPage: true,
      });
      const mobile = await pageFor(owner, true);
      await mobile.goto(`${reportPath}?q=${alpha.code}&asOfDate=${reportDate}`);
      await ready(mobile);
      await geometry(
        mobile,
        390,
        mobile.getByLabel("بحث في الحسابات", { exact: true }),
        38,
      );
      const scrolling = await table(mobile).evaluate((element) => {
        const container = element.closest(".table-scroll");
        return (
          !!container &&
          container.scrollWidth > container.clientWidth &&
          ["auto", "scroll"].includes(getComputedStyle(container).overflowX)
        );
      });
      assert(
        scrolling,
        "A wide statistics table must scroll inside its container on mobile",
      );
      await openCard(mobile, alpha);
      await geometry(
        mobile,
        390,
        card(mobile).getByLabel("ملاحظة المتابعة أو الاعتماد", { exact: true }),
        38,
      );
      assert.equal(
        await mobile.locator("html").getAttribute("data-theme"),
        "dark",
      );
      assert(
        (await card(mobile).innerText()).includes("مستقلة عن تاريخ التقرير"),
      );
      await mobile.screenshot({
        path: "work/account-statistics-browser-mobile-dark.png",
        fullPage: true,
      });
      await mobile.keyboard.press("Escape");
      await card(mobile).waitFor({ state: "detached" });
    },
  );

  assert.deepEqual(pageErrors, [], "Unexpected browser errors");
} finally {
  for (const context of browserContexts) await context.close();
  for (const context of apiContexts) await context.dispose();
  await browser?.close();
  if (server?.listening)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  await runtime?.close();
  const cleanup = new Pool({ connectionString: databaseUrl });
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await cleanup.end();
  }
}
console.log(
  `Account-statistics browser scenarios: ${passed} passed, ${failures.length} failed`,
);
assert.equal(passed, 7, "Every focused scenario must execute and pass");
assert.deepEqual(failures, []);
