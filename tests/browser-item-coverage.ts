import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  type Page,
} from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Company,
  CompanyCurrency,
  Item,
  ItemCoverage,
  Location,
  Page as ApiPage,
  SessionResponse,
} from "../packages/contracts/src/index.ts";

// Isolated schema, real stock and invoice APIs, and test-only identities.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `browser_item_coverage_${process.pid}_${Date.now()}`;
const email = "owner@coverage.browser.test";
const password = "Coverage-browser-password-2026";
const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    assert(address && typeof address === "object");
    probe.close(() => resolve(address.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let api: APIRequestContext | undefined;
let session: SessionResponse = { user: null, csrf: null };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  assert(api);
  const response = await api.fetch(`/api${path}`, {
    method,
    headers: { Origin: origin, ...(session.csrf ? { "x-csrf-token": session.csrf } : {}) },
    ...(body === undefined ? {} : { data: body }),
  });
  const result: unknown = await response.json();
  assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`);
  return result as T;
}

async function pageFor(mobile = false) {
  assert(browser && api);
  const context = await browser.newContext({
    baseURL: origin,
    storageState: await api.storageState(),
    timezoneId: "Asia/Aden",
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  context.setDefaultTimeout(15000);
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.message));
  return page;
}

async function eventually<T>(read: () => Promise<T>, check: (value: T) => void) {
  const deadline = Date.now() + 15000;
  let lastError: unknown;
  do {
    try {
      const value = await read();
      check(value);
      return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw lastError;
}

async function assertGeometry(page: Page, width: number, inputHeight: number) {
  const actual = await page.evaluate(() => ({
    direction: getComputedStyle(document.documentElement).direction,
    width: innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.equal(actual.direction, "rtl");
  assert.equal(actual.width, width);
  assert(actual.html <= width + 1 && actual.body <= width + 1, JSON.stringify(actual));
  const reserve = await page.getByLabel("كمية احتياط", { exact: true }).evaluate(element => ({
    height: element.getBoundingClientRect().height,
    font: getComputedStyle(element).fontSize,
  }));
  assert.equal(reserve.height, inputHeight);
  assert.equal(reserve.font, "14px");
}

function coverageCard(page: Page) {
  return page.locator("section.card").filter({ has: page.getByRole("heading", { name: "كفاية الصنف", exact: true }) });
}

async function assertCard(page: Page, approximate: string | null, after: string | null) {
  const card = coverageCard(page);
  await eventually(() => card.locator("dd").allTextContents(), values => {
    assert.equal(values[1]?.trim(), approximate ?? "—");
    assert.equal(values[2]?.trim(), after ?? "—");
  });
}

async function assertList(page: Page, base: string, approximate: string | null, after: string | null) {
  await page.goto(`${base}/items`);
  const table = page.getByRole("table", { name: "جدول الأصناف" });
  await table.getByRole("columnheader", { name: /الكفاية التقريبية/ }).waitFor();
  await eventually(async () => {
    const headers = await table.getByRole("columnheader").allTextContents();
    const cells = await table.locator("tbody tr").first().getByRole("cell").allTextContents();
    return {
      approximate: cells[headers.findIndex(text => text.includes("الكفاية التقريبية"))]?.trim(),
      after: cells[headers.findIndex(text => text.includes("الكفاية بعد الاحتياط"))]?.trim(),
    };
  }, values => {
    assert.equal(values.approximate, approximate ?? "—");
    assert.equal(values.after, after ?? "—");
  });
}

try {
  app = await createApp({ databaseUrl, schema, appOrigin: origin, production: false, serveStatic: true });
  await provisionOwner(app.pool, { name: "Coverage Owner", displayName: "Coverage Owner", email, password });
  server = app.app.listen(port, "127.0.0.1");
  await once(server, "listening");
  api = await request.newContext({ baseURL: origin });
  session = await call<SessionResponse>("/auth/login", "POST", { email, password });
  const company = (await call<{ company: Company }>("/companies", "POST", { name: "شركة اختبار الكفاية", phone: "", address: "عدن" })).company;
  const base = `/companies/${company.id}`;
  const currency = (await call<ApiPage<CompanyCurrency>>(`${base}/currencies`)).items.find(row => row.code === "YER")!;
  const location = (await call<ApiPage<Location>>(`${base}/locations`)).items.find(row => row.code === "SHOWROOM")!;
  const account = (await call<{ account: { id: number } }>(`${base}/accounts`, "POST", {
    code: "1111999997", name: "حساب اختبار الكفاية", kind: "posting", category: "asset", normalSide: "debit", parentId: null,
  })).account;
  const item = (await call<{ item: Item }>(`${base}/items`, "POST", {
    idempotencyKey: randomUUID(), name: "صنف اختبار الكفاية", currencyId: currency.id,
    unit1Name: "علبة", unit2Name: "حبة", factor2: 10, salePrice1: "10", salePrice2: "1", hasExpiry: false,
  })).item;
  assert.equal(item.reserveQuantity, "0");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await call(`${base}/stock-adjustments`, "POST", {
    idempotencyKey: randomUUID(), documentDate: today, itemId: item.id, locationId: location.id,
    countedQuantity: "100", expectedQuantitySmallest: "0", unit: 2, expiryDate: null, unitCostBase: "1", description: "رصيد اختبار الكفاية",
  });
  await call(`${base}/invoices`, "POST", {
    idempotencyKey: randomUUID(), kind: "sale", documentDate: today, currencyId: currency.id,
    branchId: location.branchId, locationId: location.id, counterpartyAccountId: account.id,
    discount: "0", description: "مبيعات اختبار الكفاية",
    lines: [{ itemId: item.id, unit: 2, quantity: "30", unitPrice: "1", expiryDate: null, originalLineId: null }],
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const page = await pageFor();
  const itemPath = `${base}/items/${item.id}`;
  await page.goto(itemPath);
  const reserveField = page.getByLabel("كمية احتياط", { exact: true });
  await reserveField.waitFor();
  assert.equal(await reserveField.inputValue(), "0");
  assert.match(await reserveField.locator("..").textContent() ?? "", /أصغر وحدة مفعّلة: حبة/);
  await assertGeometry(page, 1440, 32);

  async function saveReserve(quantity: string, expected: string) {
    await reserveField.fill(quantity);
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api${itemPath}` && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "حفظ الصنف", exact: true }).click();
    const response = await responsePromise;
    assert(response.ok(), await response.text());
    const saved = ((await response.json()) as { item: Item }).item;
    assert.equal(saved.reserveQuantity, expected);
    assert(saved.revision > item.revision);
    await eventually(() => reserveField.inputValue(), value => assert.equal(value, expected));
    return (await call<{ coverage: ItemCoverage }>(`${itemPath}/coverage`)).coverage;
  }

  const initial = (await call<{ coverage: ItemCoverage }>(`${itemPath}/coverage`)).coverage;
  assert.equal(Number(initial.approximateCoverageDays), 70);
  assert.equal(Number(initial.coverageAfterReserveDays), 70);
  const saved = await saveReserve("١٠", "10");
  assert.equal(Number(saved.approximateCoverageDays), 70);
  assert.equal(Number(saved.coverageAfterReserveDays), 60);
  await assertCard(page, saved.approximateCoverageDays, saved.coverageAfterReserveDays);
  await page.reload();
  await eventually(() => reserveField.inputValue(), value => assert.equal(value, "10"));
  await assertCard(page, saved.approximateCoverageDays, saved.coverageAfterReserveDays);
  assert.match(await coverageCard(page).locator("dd").first().textContent() ?? "", /10.*حبة/);
  await assertList(page, base, saved.approximateCoverageDays, saved.coverageAfterReserveDays);
  console.log("PASS reserve edits normalize Arabic digits, save/reload, and update card and list coverage");

  await page.goto(itemPath);
  await reserveField.waitFor();
  const oversized = await saveReserve("9007199254740993", "9007199254740993");
  assert.equal(Number(oversized.coverageAfterReserveDays), 0);
  await page.reload();
  await eventually(() => reserveField.inputValue(), value => assert.equal(value, "9007199254740993"));
  await assertCard(page, oversized.approximateCoverageDays, oversized.coverageAfterReserveDays);
  await assertList(page, base, oversized.approximateCoverageDays, oversized.coverageAfterReserveDays);
  const mobile = await pageFor(true);
  await mobile.goto(itemPath);
  await mobile.getByLabel("كمية احتياط", { exact: true }).waitFor();
  await assertGeometry(mobile, 390, 38);
  await assertCard(mobile, oversized.approximateCoverageDays, oversized.coverageAfterReserveDays);
  console.log("PASS reserves above stock clamp coverage to zero without losing large-integer precision; desktop/mobile stay compact RTL");

  session = await call<SessionResponse>("/auth/register", "POST", {
    name: "Coverage Reader", displayName: "Coverage Reader", email: "reader@coverage.browser.test", phone: "", password,
  });
  const readerId = session.user!.id;
  session = await call<SessionResponse>("/auth/login", "POST", { email, password });
  await call(`${base}/employees`, "POST", { userId: readerId, name: "قارئ الأصناف", phone: "", role: "employee", active: true, permissions: ["items.view"] });
  session = await call<SessionResponse>("/auth/login", "POST", { email: "reader@coverage.browser.test", password });
  const readerPage = await pageFor();
  await readerPage.goto(itemPath);
  await readerPage.getByLabel("كمية احتياط", { exact: true }).waitFor();
  assert(await readerPage.getByLabel("كمية احتياط", { exact: true }).isDisabled());
  await assertCard(readerPage, null, null);
  await assertList(readerPage, base, null, null);
  console.log("PASS item-only readers see persisted reserve read-only and redacted coverage in card and list");
  assert.deepEqual(pageErrors, [], "Unexpected browser errors");
} finally {
  for (const context of contexts) await context.close();
  await browser?.close();
  await api?.dispose();
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await app?.close();
  const cleanup = new Pool({ connectionString: databaseUrl });
  try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await cleanup.end(); }
}
