import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { chromium, request } from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { SessionResponse } from "../packages/contracts/src/index.ts";

// Focused regression for invoice keyboard and asynchronous item selection.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `invoice_focus_${randomUUID().replaceAll("-", "")}`;
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
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
let csrf: string | null = null;
async function call<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await api.fetch("/api" + path, {
    method,
    headers: { origin, ...(csrf ? { "x-csrf-token": csrf } : {}) },
    ...(data === undefined ? {} : { data }),
  });
  const body = await response.json();
  assert(
    response.ok(),
    `${method} ${path}: ${response.status()} ${JSON.stringify(body)}`,
  );
  return body as T;
}
try {
  await provisionOwner(runtime.pool, {
    name: "Focus review",
    displayName: "Focus",
    email: "focus@example.test",
    password: "invoice-focus-passphrase",
  });
  csrf = (
    await call<SessionResponse>("/auth/login", "POST", {
      email: "focus@example.test",
      password: "invoice-focus-passphrase",
    })
  ).csrf;
  const { company } = await call<{ company: { id: number } }>(
    "/companies",
    "POST",
    { name: "Focus review", phone: "", address: "" },
  );
  const base = `/companies/${company.id}`;
  const currencies = await call<{ items: { id: number; code: string }[] }>(
    base + "/currencies",
  );
  const currencyId = currencies.items.find((c) => c.code === "YER")!.id;
  await call(base + "/accounts", "POST", {
    name: "Recent account", kind: "posting", category: "asset",
    normalSide: "debit", parentId: null,
  });
  const employeeSession = await request.newContext({ baseURL: origin });
  try {
    const registered = await employeeSession.post("/api/auth/register", {
      data: {
        name: "Focus worker", displayName: "Worker",
        email: "focus.worker@example.test", phone: "",
        password: "invoice-focus-worker-passphrase",
      },
      headers: { origin },
    });
    assert.equal(registered.status(), 201, await registered.text());
    const account = await registered.json() as { user: { id: number } };
    await call(base + "/employees", "POST", {
      userId: account.user.id, name: "Focus worker",
      phone: "", role: "employee", active: true, permissions: [],
    });
  } finally { await employeeSession.dispose(); }
  await call(base + "/items", "POST", {
    name: "Focus item",
    barcode: "FOCUS-001",
    currencyId,
    salePrice1: "5",
    idempotencyKey: randomUUID(),
  });
  await call(base + "/items", "POST", {
    name: "Other fresh item", barcode: "FRESH-002", currencyId,
    salePrice1: "8", idempotencyKey: randomUUID(),
  });
  const context = await browser.newContext({
    baseURL: origin,
    storageState: await api.storageState(),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Hold the next request long enough to verify that the previous search
  // is not rendered as a faded or disabled suggestion while typing.
  await page.route("**/commerce-options?**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("type") === "items" && url.searchParams.get("q") === "Other fresh item")
      await new Promise(resolve => setTimeout(resolve, 450));
    await route.continue();
  });
  await page.goto(base + "/invoices/new?kind=sale");
  const rows = page.locator(".commerce-matrix tbody tr");
  const search = rows.first().locator('input[type="search"]');
  const itemResults = page.getByRole("listbox", { name: "نتائج الأصناف" });
  await search.fill("Focus item");
  await itemResults.getByRole("button", { name: /Focus item/ }).waitFor();
  await search.fill("Other fresh item");
  assert.equal(await itemResults.getByRole("button", { name: /Focus item/ }).count(), 0,
    "Sales search must hide stale suggestions immediately on input change");
  await page.waitForTimeout(165);
  assert.equal(await itemResults.getByRole("button", { name: /Focus item/ }).count(), 0,
    "Sales search must not expose stale suggestions while the next query is pending");
  await itemResults.getByRole("button", { name: /Other fresh item/ }).waitFor();
  await search.fill("Focus item");
  await itemResults.getByRole("button", { name: /Focus item/ }).click();
  async function focused(id: string) {
    await page.waitForFunction(
      (target) => document.activeElement?.id === target,
      id,
    );
  }
  const firstQuantity = rows.first().locator('[id^="invoice-quantity-"]');
  await focused((await firstQuantity.getAttribute("id"))!);
  await search.focus();
  await search.press("Enter");
  await focused((await firstQuantity.getAttribute("id"))!);
  await firstQuantity.fill("2");
  await firstQuantity.press("Enter");
  const nextSearch = rows.nth(1).locator('input[type="search"]');
  await focused((await nextSearch.getAttribute("id"))!);
  await page.route("**/commerce-options?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("type") === "items")
      await new Promise((resolve) => setTimeout(resolve, 80));
    await route.continue();
  });
  await nextSearch.fill("FOCUS-001");
  await nextSearch.press("Enter");
  const secondQuantity = rows.nth(1).locator('[id^="invoice-quantity-"]');
  await focused((await secondQuantity.getAttribute("id"))!);
  assert.equal(await secondQuantity.inputValue(), "1");

  // Purchase flow is distinct from sales: item -> quantity -> price -> expiry.
  await page.goto(base + "/invoices/new?kind=purchase");
  const purchaseRows = page.locator(".commerce-matrix tbody tr");
  const purchaseSearch = purchaseRows.first().locator('input[type="search"]');
  const purchaseResults = page.getByRole("listbox", { name: "نتائج الأصناف" });
  await purchaseSearch.fill("Focus item");
  await purchaseResults.getByRole("button", { name: /Focus item/ }).waitFor();
  await purchaseSearch.fill("Other fresh item");
  assert.equal(await purchaseResults.getByRole("button", { name: /Focus item/ }).count(), 0,
    "Purchase search must hide stale suggestions immediately on input change");
  await page.waitForTimeout(165);
  assert.equal(await purchaseResults.getByRole("button", { name: /Focus item/ }).count(), 0,
    "Purchase search must not expose stale suggestions while loading");
  await purchaseResults.getByRole("button", { name: /Other fresh item/ }).waitFor();
  await purchaseSearch.fill("Focus item");
  await purchaseResults.getByRole("button", { name: /Focus item/ }).click();
  const purchaseQuantity = purchaseRows.first().locator('[id^="invoice-quantity-"]');
  await focused((await purchaseQuantity.getAttribute("id"))!);
  await purchaseQuantity.fill("3");
  await purchaseQuantity.press("Enter");
  const purchasePrice = purchaseRows.first().locator('[id^="invoice-price-"]');
  await focused((await purchasePrice.getAttribute("id"))!);
  await purchasePrice.fill("11");
  await purchasePrice.press("Enter");
  const purchaseExpiry = purchaseRows.first().locator('input[id^="invoice-expiry-"]:not([id$="-year"])');
  await focused((await purchaseExpiry.getAttribute("id"))!);
  // The avatar search must follow the last record clicked in each list,
  // not only an editor that was opened or a previously searched item.
  async function assertRecent(tab: "صنف" | "حساب" | "مستخدم", text: string) {
    await page.getByRole("button", { name: "قائمة المستخدم" }).click();
    await page.getByRole("tab", { name: tab }).click();
    const input = page.getByRole("combobox", { name: `البحث عن ${tab}` });
    assert.equal(await input.inputValue(), text,
      `The user-menu ${tab} must show the last clicked record`);
    await page.getByRole("button", { name: "قائمة المستخدم" }).click();
  }
  await assertRecent("صنف", "Focus item");
  await page.goto(base + "/items");
  await page.getByRole("table", { name: "جدول الأصناف" })
    .getByText("Other fresh item", { exact: true }).click();
  await page.getByRole("dialog", { name: "القيمة الكاملة" })
    .getByRole("button", { name: "إغلاق النافذة" }).click();
  await assertRecent("صنف", "Other fresh item");
  // The avatar item tab starts with a scalable three-column action grid.
  // An action replaces the grid with ten real-result slots; tapping the
  // already-active top Item tab restores the actions without losing the item.
  await page.route("**/item-history/**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("type") !== "purchase") return route.continue();
    const pageNumber = Number(url.searchParams.get("page"));
    assert.equal(url.searchParams.get("pageSize"), "10");
    const offset = (pageNumber - 1) * 10;
    const items = Array.from({ length: pageNumber === 1 ? 10 : 2 }, (_, index) => ({
      lineId: offset + index + 1,
      documentId: offset + index + 1,
      documentDate: "2026-10-24",
      partyName: `Supplier ${offset + index + 1}`,
      quantityFirstUnit: "1",
      unitPriceFirstUnit: "100",
      currencyCode: "YER",
    }));
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ items, hasMore: pageNumber === 1 }) });
  });
  await page.getByRole("button", { name: "قائمة المستخدم" }).click();
  const itemTab = page.getByRole("tab", { name: "صنف", exact: true });
  await itemTab.click();
  const itemGrid = page.locator(".user-menu-item-actions");
  await itemGrid.waitFor();
  assert.deepEqual(await itemGrid.locator("button").allTextContents(),
    ["مشتريات", "مبيعات", "تسويات", "مناقلات", "البدائل"]);
  await itemGrid.getByRole("button", { name: "مشتريات" }).click();
  await itemGrid.waitFor({ state: "hidden" });
  const historyRows = page.locator(".user-menu-item-history-row");
  await historyRows.nth(9).waitFor();
  assert.equal(await historyRows.count(), 10);
  assert.match(await historyRows.first().innerText(), /Supplier 1/);
  await page.getByRole("button", { name: "المزيد" }).click();
  await page.getByText("الصفحة 2", { exact: true }).waitFor();
  await page.getByText("Supplier 11", { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 2);
  assert.equal(await page.getByRole("button", { name: "المزيد" }).count(), 0);
  await itemTab.click();
  await itemGrid.waitFor();
  assert.equal(await page.getByRole("combobox", { name: "البحث عن صنف" }).inputValue(),
    "Other fresh item");
  await page.getByRole("button", { name: "قائمة المستخدم" }).click();
  await page.goto(base + "/accounts");
  await page.getByRole("searchbox", { name: "بحث في الحسابات" })
    .fill("Recent account");
  await page.getByRole("table", { name: "دليل الحسابات" })
    .getByText("Recent account", { exact: true }).click();
  await page.getByRole("dialog", { name: "القيمة الكاملة" })
    .getByRole("button", { name: "إغلاق النافذة" }).click();
  await assertRecent("حساب", "Recent account");
  await page.goto(base + "/employees");
  await page.getByRole("table", { name: "قائمة موظفي الشركة" })
    .getByText("Focus worker", { exact: true }).click();
  await page.getByRole("dialog", { name: "القيمة الكاملة" })
    .getByRole("button", { name: "إغلاق النافذة" }).click();
  await assertRecent("مستخدم", "Focus worker");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: sales/purchase search, focus and latest item/account/employee from invoice and lists",
  );
  await context.close();
} finally {
  await browser.close();
  await api.dispose();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await runtime.close();
  const cleanup = new Pool({ connectionString: databaseUrl });
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await cleanup.end();
  }
}
