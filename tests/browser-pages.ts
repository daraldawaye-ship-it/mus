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
const schema = "browser_pages_" + process.pid + "_" + Date.now(),
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
  const currency = (
    await call<{ currency: { id: number } }>(
      `/companies/${company.id}/currencies`,
      "POST",
      { code: "YER", name: "ريال يمني", decimalPlaces: 2 },
    )
  ).currency;
  const item = (
    await call<{ item: Item }>(`/companies/${company.id}/items`, "POST", {
      idempotencyKey: randomUUID(),
      name: "صنف المرجع",
      currencyId: currency.id,
      unit1Name: "حبة",
      salePrice1: "10",
      purchasePrice: "7",
    })
  ).item;
  const base = `/companies/${company.id}`,
    page = await pageFor();
  await scenario(
    "directory supports Arabic search, type filters, permission details and real report navigation",
    async () => {
      await page.goto(base + "/pages");
      await page
        .getByRole("heading", { name: "قائمة الصفحات", exact: true })
        .waitFor();
      await page.getByLabel("بحث الصفحات", { exact: true }).fill("الأَصْناف");
      await page.getByRole("button", { name: "الأصناف", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "الأصناف", exact: true });
      await dialog.waitFor();
      assert.match(
        await dialog.locator(".page-directory-permissions").innerText(),
        /إدارة الأصناف/,
      );
      assert.match(
        await dialog.locator(".page-directory-permissions").innerText(),
        /عرض الأصناف/,
      );
      await page.keyboard.press("Escape");
      await page.getByLabel("بحث الصفحات", { exact: true }).fill("");
      await page
        .getByLabel("نوع الصفحة", { exact: true })
        .selectOption("report");
      await page
        .getByRole("link", { name: "فتح حركات المخزون", exact: true })
        .click();
      await page.waitForURL("**" + base + "/stock-movements");
      await page
        .getByRole("heading", { name: "حركات المخزون", exact: true })
        .waitFor();
    },
  );
  await scenario(
    "hidden pages leave navigation yet retain authorized stable links and can be restored",
    async () => {
      await page.goto(base + "/pages?q=" + encodeURIComponent("company.items"));
      await page.getByRole("button", { name: "الأصناف", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "الأصناف", exact: true });
      await dialog.getByLabel("إظهار في التنقل", { exact: true }).uncheck();
      await dialog
        .getByRole("button", { name: "حفظ إعدادات الصفحة", exact: true })
        .click();
      await dialog
        .getByText("تم حفظ إعدادات الصفحة وتحديث الدليل وقائمة التنقل.", {
          exact: true,
        })
        .waitFor();
      await eventually(
        async () =>
          (await page.locator(`.sidebar a[href="${base}/items"]`).count()) ===
          0,
      );
      await page.keyboard.press("Escape");
      await page
        .getByRole("link", { name: "فتح الأصناف", exact: true })
        .click();
      await page.waitForURL("**" + base + "/items");
      await page
        .getByRole("heading", { name: "الأصناف", exact: true })
        .waitFor();
      await page.goto(base + "/pages?q=company.items");
      await page.getByRole("button", { name: "الأصناف", exact: true }).click();
      const restored = page.getByRole("dialog", {
        name: "الأصناف",
        exact: true,
      });
      await restored.getByLabel("إظهار في التنقل", { exact: true }).check();
      await restored
        .getByRole("button", { name: "حفظ إعدادات الصفحة", exact: true })
        .click();
      await restored
        .getByText("تم حفظ إعدادات الصفحة وتحديث الدليل وقائمة التنقل.", {
          exact: true,
        })
        .waitFor();
      await page.keyboard.press("Escape");
    },
  );
  await scenario(
    "disabled pages reject a typed route and remain configurable through the protected directory",
    async () => {
      await page.getByRole("button", { name: "الأصناف", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "الأصناف", exact: true });
      await dialog.getByLabel("تفعيل الصفحة", { exact: true }).uncheck();
      await dialog
        .getByRole("button", { name: "حفظ إعدادات الصفحة", exact: true })
        .click();
      await dialog
        .getByText("تم حفظ إعدادات الصفحة وتحديث الدليل وقائمة التنقل.", {
          exact: true,
        })
        .waitFor();
      await page.goto(base + "/items");
      await page
        .getByText("هذه الصفحة معطلة. راجع مسؤول النطاق.", { exact: true })
        .waitFor();
      await page
        .getByRole("link", { name: "قائمة الصفحات", exact: true })
        .last()
        .click();
      await page
        .getByLabel("بحث الصفحات", { exact: true })
        .fill("company.items");
      await page.getByRole("button", { name: "الأصناف", exact: true }).click();
      const enabled = page.getByRole("dialog", {
        name: "الأصناف",
        exact: true,
      });
      await enabled.getByLabel("تفعيل الصفحة", { exact: true }).check();
      await enabled
        .getByRole("button", { name: "حفظ إعدادات الصفحة", exact: true })
        .click();
      await enabled
        .getByText("تم حفظ إعدادات الصفحة وتحديث الدليل وقائمة التنقل.", {
          exact: true,
        })
        .waitFor();
      await page.keyboard.press("Escape");
    },
  );
  await scenario(
    "record references resolve the selected company item and reject foreign or missing records",
    async () => {
      await page.goto(base + "/pages?q=company.item-card");
      await page
        .getByRole("button", { name: "كرت الصنف", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "كرت الصنف",
        exact: true,
      });
      assert.equal(
        await dialog
          .getByRole("button", { name: "فتح الصفحة", exact: true })
          .isDisabled(),
        true,
      );
      await dialog
        .getByLabel("معرف السجل المطلوب", { exact: true })
        .fill(String(item.id));
      await dialog
        .getByRole("link", { name: "فتح الصفحة", exact: true })
        .click();
      await page.waitForURL("**" + base + "/items/" + item.id);
      await page.getByLabel("اسم الصنف", { exact: true }).waitFor();
      await page.goto(
        `/go/company.item-card?companyId=${company.id}&recordId=2147483647`,
      );
      await page
        .getByRole("heading", { name: "تعذر فتح مرجع الصفحة", exact: true })
        .waitFor();
    },
  );
  await scenario(
    "directory retains compact RTL desktop/mobile geometry and consistent navigation order",
    async () => {
      await page.goto(base + "/pages?q=company.items");
      await page.getByRole("button", { name: "الأصناف", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "الأصناف", exact: true });
      await dialog.getByLabel("ترتيب الظهور", { exact: true }).fill("0");
      await dialog
        .getByRole("button", { name: "حفظ إعدادات الصفحة", exact: true })
        .click();
      await dialog
        .getByText("تم حفظ إعدادات الصفحة وتحديث الدليل وقائمة التنقل.", {
          exact: true,
        })
        .waitFor();
      await page.keyboard.press("Escape");
      const links = await page
        .locator('.sidebar a[href^="' + base + '"]')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("href")),
        );
      assert.equal(links[0], base + "/items");
      await page.goto(base + "/pages?type=report");
      await page
        .getByRole("heading", { name: "قائمة الصفحات", exact: true })
        .waitFor();
      await geometry(page, 1440);
      await page.screenshot({
        path: "/workspace/work/page-directory-desktop.png",
        fullPage: true,
      });
      const mobile = await pageFor(true);
      await mobile.goto(base + "/pages");
      await mobile
        .getByRole("heading", { name: "قائمة الصفحات", exact: true })
        .waitFor();
      await geometry(mobile, 390);
      await mobile
        .getByLabel("بحث الصفحات", { exact: true })
        .fill("company.sales");
      await mobile
        .getByRole("button", { name: "فواتير المبيعات", exact: true })
        .click();
      await mobile
        .getByRole("dialog", { name: "فواتير المبيعات", exact: true })
        .waitFor();
      await geometry(mobile, 390);
      await mobile.screenshot({
        path: "/workspace/work/page-directory-mobile.png",
        fullPage: true,
      });
      const directory = await call<PageDirectory>(
        "/page-catalog?companyId=" + company.id,
      );
      assert(directory.summary.total >= 35);
    },
  );
  await scenario(
    "one phone tap opens shortcuts, a second closes them, and desktop hover still works",
    async () => {
      const phone=await pageFor(true);
      await phone.goto("/");
      await phone.getByRole("button",{name:"قائمة المستخدم"}).tap();
      const shortcuts=phone.locator(".user-shortcut-root > button");
      await shortcuts.waitFor({state:"visible"});
      assert.equal(await shortcuts.getAttribute("aria-expanded"),"false");
      await shortcuts.tap();
      assert.equal(await shortcuts.getAttribute("aria-expanded"),"true",
        "First touch must open the menu, not merely highlight its trigger");
      await phone.locator(".user-shortcut-flyout").waitFor({state:"visible"});
      assert.equal(await phone.locator(".user-shortcut-flyout").count(),1);
      await shortcuts.tap();
      assert.equal(await shortcuts.getAttribute("aria-expanded"),"false");
      const desktop=await pageFor();
      await desktop.goto("/");
      await desktop.getByRole("button",{name:"قائمة المستخدم"}).click();
      const desktopShortcut=desktop.locator(".user-shortcut-root > button");
      await desktopShortcut.hover();
      assert.equal(await desktopShortcut.getAttribute("aria-expanded"),"true",
        "The mouse hover behavior must remain available on desktop");
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
  `Page directory browser scenarios: ${passed} passed, ${failures.length} failed`,
);
assert.equal(failures.length, 0, failures.join(", "));
