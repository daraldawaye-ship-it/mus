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

// Focused first-stage attendance browser flow.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `attendance_browser_${randomUUID().replaceAll("-", "")}`;
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
    name: "Attendance owner",
    displayName: "Owner",
    email: "attendance.owner@example.test",
    password: "attendance-browser-passphrase",
  });
  csrf = (
    await call<SessionResponse>("/auth/login", "POST", {
      email: "attendance.owner@example.test",
      password: "attendance-browser-passphrase",
    })
  ).csrf;
  const { company } = await call<{ company: { id: number } }>(
    "/companies",
    "POST",
    { name: "Attendance browser", phone: "", address: "" },
  );
  const base = `/companies/${company.id}`;
  const staffApi = await request.newContext({ baseURL: origin });
  const registration = await staffApi.post("/api/auth/register", {
    headers: { origin },
    data: {
      name: "Employee",
      displayName: "Employee",
      email: "attendance.staff@example.test",
      phone: "",
      password: "attendance-browser-passphrase",
    },
  });
  assert(registration.ok());
  const session = (await registration.json()) as SessionResponse;
  const { employee } = await call<{ employee: { id: number } }>(
    base + "/employees",
    "POST",
    {
      userId: session.user!.id,
      name: "الموظف التجريبي",
      phone: "",
      role: "employee",
      active: true,
      permissions: [],
    },
  );
  const ownerContext = await browser.newContext({
    baseURL: origin,
    storageState: await api.storageState(),
  });
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(8000);
  await ownerPage.goto(base + "/attendance");
  await ownerPage
    .getByRole("button", { name: "إعداد دوام الموظف التجريبي", exact: true })
    .click();
  const dialog = ownerPage.getByRole("dialog");
  await dialog.getByLabel("الجمعة", { exact: true }).check();
  await dialog.getByLabel("السبت", { exact: true }).check();
  await dialog.getByRole("button", { name: "حفظ الدوام", exact: true }).click();
  await ownerPage.getByText("تم حفظ إعداد الدوام.", { exact: true }).waitFor();
  const employeeContext = await browser.newContext({
    baseURL: origin,
    storageState: await staffApi.storageState(),
    viewport: { width: 390, height: 844 },
  });
  const page = await employeeContext.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/attendance");
  assert.equal(
    await page
      .getByRole("table", { name: "إعداد دوام الموظفين", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "تسجيل الحضور", exact: true }).click();
  await page.getByText(/تم تسجيل الحضور:/).waitFor();
  assert(
    await page
      .getByRole("button", { name: "تسجيل الحضور", exact: true })
      .isDisabled(),
  );
  await page
    .getByRole("button", { name: "تسجيل الانصراف", exact: true })
    .click();
  await page.getByText(/تم تسجيل الانصراف:/).waitFor();
  const table = page.getByRole("table", {
    name: "سجل الحضور والانصراف",
    exact: true,
  });
  assert.equal(await table.locator("tbody tr[data-row-id]").count(), 1);
  assert(
    await page
      .getByRole("button", { name: "تسجيل الانصراف", exact: true })
      .isDisabled(),
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  assert.deepEqual(errors, []);
  const overview = await call<{ items: { employeeId: number }[] }>(
    base + "/attendance",
  );
  assert.equal(overview.items[0]!.employeeId, employee.id);
  console.log(
    "PASS: manager schedule setup, private mobile employee check-in/out, daily log and duplicate controls",
  );
  await ownerContext.close();
  await employeeContext.close();
  await staffApi.dispose();
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
