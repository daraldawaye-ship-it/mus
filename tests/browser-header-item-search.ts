import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `header_search_${randomUUID().replaceAll("-", "")}`;
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
const runtime = await createApp({ databaseUrl, schema, appOrigin: origin, production: false, serveStatic: true });
const server = runtime.app.listen(port, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve); server.once("error", reject);
});
let browser: Browser | undefined;
try {
  // This account and database schema exist only for this disposable browser test.
  const password = "Header-item-search-test-only-2026";
  await provisionOwner(runtime.pool, { name: "Header test", displayName: "Header test", email: "header@test.invalid", password });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true,
  });
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1100, height: 800 } });
  let csrf = "";
  const post = async (path: string, body: unknown, status = 201) => {
    const response = await context.request.post(`/api${path}`, {
      headers: { origin, "x-csrf-token": csrf }, data: body,
    });
    assert.equal(response.status(), status, await response.text());
    return response.json();
  };
  csrf = (await post("/auth/login", { email: "header@test.invalid", password }, 200)).csrf;
  const company = (await post("/companies", { name: "Header search fixture", phone: "", address: "" })).company;
  const prefix = `/companies/${company.id}`;
  const currency = (await (await context.request.get(`/api${prefix}/currencies`)).json()).items
    .find((value: { code: string }) => value.code === "YER");
  assert(currency);
  const expected = (await post(`${prefix}/items`, {
    idempotencyKey: randomUUID(), name: "اسبرين اختبار القائمة العلوية", englishName: "Aspirin header fixture",
    currencyId: currency.id, unit1Name: "حبة", hasExpiry: false,
  })).item;
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(prefix, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "قائمة المستخدم", exact: true }).click();
  await page.getByRole("tab", { name: "صنف", exact: true }).click();
  const input = page.getByRole("combobox", { name: "البحث عن صنف", exact: true });
  const response = page.waitForResponse(value => {
    const url = new URL(value.url());
    return url.pathname === `/api${prefix}/commerce-options` && url.searchParams.get("q") === "اسبر";
  });
  const started = performance.now();
  await input.fill("اسبر");
  const result = await response;
  assert.equal(result.status(), 200);
  assert.equal((await result.json()).items[0].id, expected.id);
  const editButton = page.getByRole("button", { name: "تعديل كرت الصنف" });
  assert.equal(await editButton.isDisabled(), true);
  const option = page.getByRole("option").filter({ hasText: expected.name });
  await option.waitFor();
  assert.equal(await page.getByText("جارٍ البحث…", { exact: true }).count(), 0);
  console.log(`PASS real header item search: ${Math.round(performance.now()-started)}ms through the browser`);
  await option.click();
  assert.equal(await input.inputValue(), expected.name);
  assert.equal(await editButton.isEnabled(), true);
  await editButton.click();
  await page.locator(".invoice-item-sheet").waitFor();
  assert.equal(await page.getByRole("dialog", { name: "قائمة المستخدم والأقسام" }).count(), 0);
  await mkdir("/workspace/work", { recursive: true });
  await page.screenshot({ path: "/workspace/work/header-item-search-verified.png" });
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await runtime.close();
  const cleanup = new Pool({ connectionString: databaseUrl });
  try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
  finally { await cleanup.end(); }
}
