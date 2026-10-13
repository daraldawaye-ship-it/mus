import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { chromium, request, type BrowserContext, type Page } from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Company,
  Item,
  SessionResponse,
  PageDirectory,
} from "../packages/contracts/src/index.ts";

// All browser writes use a disposable schema and fake test identities.
const schema = "browser_defaults_" + process.pid + "_" + Date.now(),
  databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const password = "Browser-page-catalog-test-passphrase-2026";
const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    assert(address && typeof address !== "string");
    probe.close(() => resolve(address.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const runtime = await createApp({
  databaseUrl,
  schema,
  appOrigin: origin,
  production: false,
  serveStatic: true,
});
const server = runtime.app.listen(port, "127.0.0.1");
await once(server, "listening");
const api = await request.newContext({ baseURL: origin });
let session: SessionResponse = { user: null, csrf: null };
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const contexts: BrowserContext[] = [],
  errors: string[] = [],
  failures: string[] = [];
let passed = 0;
async function call<T>(path: string, method = "GET", body?: unknown) {
  const response = await api.fetch("/api" + path, {
    method,
    headers: {
      origin,
      ...(session.csrf ? { "x-csrf-token": session.csrf } : {}),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  const value = await response.json();
  assert(
    response.ok(),
    method + " " + path + " " + response.status() + " " + JSON.stringify(value),
  );
  return value as T;
}
async function pageFor(mobile = false) {
  const context = await browser.newContext({
    baseURL: origin,
    storageState: await api.storageState(),
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 960 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  context.setDefaultTimeout(12000);
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      /cannot be a descendant|cannot contain a nested|same key/.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  return page;
}
async function eventually(read: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Expected browser state did not arrive");
}
async function scenario(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name);
    console.error("FAIL " + name, error);
  }
}
async function geometry(page: Page, width: number) {
  const bounds = await page.evaluate(() => ({
    width: innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    direction: getComputedStyle(document.documentElement).direction,
  }));
  assert.equal(bounds.width, width);
  assert.equal(bounds.direction, "rtl");
  assert(
    bounds.html <= width + 1 && bounds.body <= width + 1,
    JSON.stringify(bounds),
  );
}
try {
  await mkdir("/workspace/work", { recursive: true });
  const owner = await provisionOwner(runtime.pool, {
    name: "Directory owner",
    displayName: "Directory owner",
    email: "owner@directory.browser.test",
    password,
  });
  session = await call<SessionResponse>("/auth/login", "POST", {
    email: owner.email,
    password,
  });
  const company = (
    await call<{ company: Company }>("/companies", "POST", {
      name: "شركة دليل الصفحات",
      phone: "",
      address: "",
    })
  ).company;
  const base = `/companies/${company.id}`,
    page = await pageFor();
  await scenario(
    "automatic company accounts/currencies, account codes and Yemeni item currency",
    async () => {
      const accounts = await call<{
        items: {
          id: number;
          code: string;
          name: string;
          rangeStart: string | null;
        }[];
        total: number;
      }>(base + "/accounts?pageSize=100");
      assert.equal(accounts.total, 18);
      const currencies = await call<{ items: { id: number; code: string }[] }>(
        base + "/currencies",
      );
      assert.deepEqual(currencies.items.map((value) => value.code).sort(), [
        "SAR",
        "USD",
        "YER",
      ]);
      const yer = currencies.items.find((value) => value.code === "YER")!;
      const settings = await call<{ settings: { baseCurrencyId: number } }>(
        base + "/finance-settings",
      );
      assert.equal(settings.settings.baseCurrencyId, yer.id);
      await page.goto(base + "/accounts");
      await page
        .getByRole("heading", { name: "دليل الحسابات", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "تهيئة دليل مقترح", exact: true })
          .count(),
        0,
      );
      await page
        .getByRole("button", { name: "إضافة حساب", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "إضافة حساب",
        exact: true,
      });
      assert.equal(
        await dialog.getByLabel("كود الحساب", { exact: true }).inputValue(),
        "تلقائي عند الحفظ",
      );
      assert.equal(
        await dialog
          .getByLabel("كود الحساب", { exact: true })
          .getAttribute("readonly"),
        "",
      );
      await dialog
        .getByLabel("اسم الحساب", { exact: true })
        .fill("حساب تلقائي");
      await dialog
        .getByRole("button", { name: "حفظ الحساب", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const created = await call<{ items: { code: string }[] }>(
        base + "/accounts?q=" + encodeURIComponent("حساب تلقائي"),
      );
      assert.match(created.items[0]!.code, /^\d{10}$/);
      const parent = accounts.items.find(
        (account) => account.name === "العملاء",
      )!;
      const one = await call<{ account: { code: string } }>(
        base + "/accounts",
        "POST",
        {
          name: "عميل تلقائي",
          parentId: parent.id,
          kind: "posting",
          category: "asset",
          normalSide: "debit",
        },
      );
      assert.equal(one.account.code, parent.rangeStart);
      const group = await call<{ account: { code: string } }>(
        base + "/accounts",
        "POST",
        {
          name: "مجموعة تلقائية",
          kind: "group",
          category: "expense",
          normalSide: "debit",
        },
      );
      assert.match(group.account.code, /^5\d{9}$/);
      await page.goto(base + "/currencies");
      await page
        .getByRole("heading", { name: "العملات", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "تهيئة العملات", exact: true })
          .count(),
        0,
      );
      await page.goto(base + "/items/new");
      await page.getByLabel("اسم الصنف", { exact: true }).waitFor();
      await page.getByRole("button", { name: /YER/ }).waitFor();
      await page
        .getByLabel("اسم الصنف", { exact: true })
        .fill("صنف بالعملة الافتراضية");
      await page
        .getByRole("button", { name: "حفظ الصنف", exact: true })
        .click();
      await page.waitForURL(new RegExp(base + "/items/[1-9]\\d*$"));
      const items = await call<{ items: { currencyId: number }[] }>(
        base + "/items",
      );
      assert.equal(items.items[0]!.currencyId, yer.id);
    },
  );
  assert.equal(errors.length, 0, errors.join("; "));
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await api.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  const cleanup = new Pool({ connectionString: databaseUrl });
  try {
    await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await cleanup.end();
  }
}
console.log(
  `Automatic defaults checks: ${passed} passed, ${failures.length} failed`,
);
assert.equal(failures.length, 0, failures.join(", "));
