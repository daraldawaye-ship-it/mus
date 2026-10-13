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

// Focused, isolated review of the two repaired browser paths.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `review_browser_${randomUUID().replaceAll("-", "")}`;
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
    name: "Browser review",
    displayName: "Review",
    email: "browser.review@example.test",
    password: "browser-review-passphrase",
  });
  csrf = (
    await call<SessionResponse>("/auth/login", "POST", {
      email: "browser.review@example.test",
      password: "browser-review-passphrase",
    })
  ).csrf;
  const { company } = await call<{ company: { id: number } }>(
    "/companies",
    "POST",
    { name: "Browser review company", phone: "", address: "" },
  );
  const base = `/companies/${company.id}`;
  const accounts = await call<{ items: { id: number; code: string }[] }>(
    base + "/accounts",
  );
  const account = accounts.items[0]!;
  const { option } = await call<{ option: { id: number } }>(
    base + "/configuration/options",
    "POST",
    {
      key: "review.browser",
      pageKey: "company.accounts",
      recordKind: "account",
      name: "مراجعة القيمة",
      valueType: "text",
      defaultValue: "افتراضي للسجلات الجديدة",
    },
  );
  const context = await browser.newContext({
    baseURL: origin,
    storageState: await api.storageState(),
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/configuration");
  await page
    .getByRole("row")
    .filter({ hasText: "accounts.archived" })
    .getByRole("button", { name: "تعديل", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("اسم الخيار", { exact: true })
    .fill("أرشفة الحساب المعدّلة");
  const savedDefinition = page.waitForResponse(
    (response) =>
      response.url().includes("/configuration/options/") &&
      response.request().method() === "PATCH",
  );
  await dialog.getByRole("button", { name: "حفظ", exact: true }).click();
  assert.equal((await savedDefinition).status(), 200);
  await page.getByText("تم حفظ تعريف الخيار.", { exact: true }).waitFor();
  console.log("PASS browser: native option metadata can be edited");
  await page.goto(base + "/accounts");
  await page
    .getByRole("button", { name: "تعديل الحساب " + account.code, exact: true })
    .click();
  const value = page.getByLabel("مراجعة القيمة", { exact: true });
  await value.waitFor();
  assert.equal(await value.inputValue(), "");
  await value.fill("قيمة محفوظة");
  let savedValue = page.waitForResponse(
    (response) =>
      response.url().includes("/configuration/record-options") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "حفظ القيمة", exact: true }).click();
  assert.equal((await savedValue).status(), 200);
  await page
    .getByText("تم حفظ الخيار: مراجعة القيمة", { exact: true })
    .waitFor();
  await value.fill("");
  savedValue = page.waitForResponse(
    (response) =>
      response.url().includes("/configuration/record-options") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "حفظ القيمة", exact: true }).click();
  assert.equal((await savedValue).status(), 200);
  const stored = await call<{
    values: { definitionId: number; value: unknown }[];
  }>(
    base +
      `/configuration/record-options?recordKind=account&recordId=${account.id}`,
  );
  assert.equal(
    stored.values.find((row) => row.definitionId === option.id)?.value,
    null,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "تعديل الحساب " + account.code, exact: true })
    .click();
  await page.getByLabel("مراجعة القيمة", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("مراجعة القيمة", { exact: true }).inputValue(),
    "",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS browser: old records and explicit empty values keep their values, desktop/mobile",
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
