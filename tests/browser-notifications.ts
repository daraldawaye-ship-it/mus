import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { Pool } from "pg";
import { chromium, request, type APIRequestContext } from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { transaction } from "../apps/api/src/db.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { emitNotification } from "../apps/api/src/services/notifications.ts";
import type {
  NotificationDirectory,
  NotificationTemplateDirectory,
  SessionResponse,
} from "../packages/contracts/src/index.ts";

// One isolated browser flow; notifications are produced by real system events.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `notification_browser_${randomUUID().replaceAll("-", "")}`;
const password = "notifications-browser-test-passphrase";
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
const ownerApi = await request.newContext({ baseURL: origin });
const employeeApi = await request.newContext({ baseURL: origin });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
function apiClient(client: APIRequestContext) {
  let csrf: string | null = null;
  return async <T>(
    path: string,
    method = "GET",
    data?: unknown,
  ): Promise<T> => {
    const response = await client.fetch("/api" + path, {
      method,
      headers: { origin, ...(csrf ? { "x-csrf-token": csrf } : {}) },
      ...(data === undefined ? {} : { data }),
    });
    const body = await response.json();
    assert(
      response.ok(),
      `${method} ${path}: ${response.status()} ${JSON.stringify(body)}`,
    );
    if (body && typeof body === "object" && "csrf" in body) csrf = body.csrf;
    return body as T;
  };
}
const ownerCall = apiClient(ownerApi);
const employeeCall = apiClient(employeeApi);
try {
  await provisionOwner(runtime.pool, {
    name: "Notification owner",
    displayName: "Owner",
    email: "notifications-browser-owner@example.test",
    password,
  });
  await ownerCall("/auth/login", "POST", {
    email: "notifications-browser-owner@example.test",
    password,
  });
  const { company } = await ownerCall<{ company: { id: number } }>(
    "/companies",
    "POST",
    {
      name: "شركة التنبيهات الأولى",
      phone: "",
      address: "",
    },
  );
  const { company: other } = await ownerCall<{ company: { id: number } }>(
    "/companies",
    "POST",
    {
      name: "شركة التنبيهات الثانية",
      phone: "",
      address: "",
    },
  );
  const base = `/companies/${company.id}`;
  const otherBase = `/companies/${other.id}`;
  const registration = await employeeCall<SessionResponse>(
    "/auth/register",
    "POST",
    {
      name: "الموظف التجريبي",
      displayName: "الموظف",
      email: "notifications-browser-staff@example.test",
      phone: "",
      password,
    },
  );
  assert(registration.user);
  const employeeDraft = {
    userId: registration.user.id,
    name: "الموظف التجريبي",
    phone: "",
    role: "employee",
    active: true,
    permissions: [],
  };
  const { employee } = await ownerCall<{ employee: { id: number } }>(
    base + "/employees",
    "POST",
    employeeDraft,
  );
  const { employee: otherEmployee } = await ownerCall<{
    employee: { id: number };
  }>(otherBase + "/employees", "POST", employeeDraft);
  const peerUser = (
    await runtime.pool.query<{ id: number }>(
      "INSERT INTO users(name,display_name,email,password_hash) SELECT 'المتابع الإضافي','المتابع','notification-follower@example.test',password_hash FROM users WHERE id=$1 RETURNING id",
      [registration.user.id],
    )
  ).rows[0]!;
  const { employee: peer } = await ownerCall<{ employee: { id: number } }>(
    base + "/employees",
    "POST",
    {
      ...employeeDraft,
      userId: peerUser.id,
      name: "المتابع الإضافي",
    },
  );

  const ownerContext = await browser.newContext({
    baseURL: origin,
    storageState: await ownerApi.storageState(),
  });
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(8000);
  const errors: string[] = [];
  ownerPage.on("pageerror", (error) => errors.push(error.message));
  await ownerPage.goto(base + "/notification-templates");
  await ownerPage
    .getByRole("heading", { name: "أنواع التنبيهات", exact: true })
    .waitFor();
  const activeTemplate = ownerPage
    .locator(".notification-template")
    .filter({ has: ownerPage.getByText("ATTENDANCE_LATE", { exact: true }) });
  await activeTemplate
    .getByRole("button", { name: "إعداد الكرت والمتابعين", exact: true })
    .click();
  const templateDialog = ownerPage.getByRole("dialog");
  assert.equal(
    await templateDialog
      .getByLabel("التكرار الافتراضي", { exact: true })
      .inputValue(),
    "none",
  );
  await templateDialog
    .getByLabel("الأهمية الافتراضية", { exact: true })
    .selectOption("high");
  await templateDialog
    .getByLabel("السماح بالتكرار حتى الإنجاز", { exact: true })
    .check();
  await templateDialog.getByLabel("المتابع الإضافي", { exact: true }).check();
  await templateDialog.getByLabel("محاسب", { exact: true }).check();
  await templateDialog
    .getByRole("button", { name: "حفظ الكرت", exact: true })
    .click();
  await ownerPage
    .getByText("تم حفظ كرت التنبيه وإعداد متابعيه.", { exact: true })
    .waitFor();
  const saved = (
    await ownerCall<NotificationTemplateDirectory>(
      base + "/notification-templates",
    )
  ).templates.find((row) => row.code === "ATTENDANCE_LATE");
  assert(saved?.allowRepeat && saved.importance === "high");
  assert.equal(saved.repeatInterval, "none");
  assert(saved.employeeIds.includes(peer.id));
  assert.equal(saved.roleIds.length, 1);

  await ownerPage.getByLabel("البحث", { exact: true }).fill("ITEM_STOPPED");
  const plannedTemplate = ownerPage
    .locator(".notification-template")
    .filter({ has: ownerPage.getByText("ITEM_STOPPED", { exact: true }) });
  await plannedTemplate
    .getByRole("button", { name: "إعداد الكرت والمتابعين", exact: true })
    .click();
  assert(
    await templateDialog
      .getByLabel("تنبيه مفعّل", { exact: true })
      .isDisabled(),
  );
  assert.equal(
    await templateDialog.getByLabel("تنبيه مفعّل", { exact: true }).isChecked(),
    false,
  );
  await templateDialog
    .getByRole("button", { name: "إلغاء", exact: true })
    .click();

  await transaction(runtime.pool, async (client) => {
    await emitNotification(client, {
      code: "ATTENDANCE_LATE",
      companyId: company.id,
      subjectEmployeeId: employee.id,
      subjectKey: `employee:${employee.id}`,
      eventKey: "browser:first-company",
      message: "تنبيه الشركة الأولى فقط",
      href: base + "/attendance",
    });
    await emitNotification(client, {
      code: "ATTENDANCE_LATE",
      companyId: other.id,
      subjectEmployeeId: otherEmployee.id,
      subjectKey: `employee:${otherEmployee.id}`,
      eventKey: "browser:second-company",
      message: "تنبيه الشركة الثانية فقط",
      href: otherBase + "/attendance",
    });
  });
  await employeeCall("/auth/password", "POST", {
    currentPassword: password,
    newPassword: "notifications-browser-new-passphrase",
  });
  const initial = await employeeCall<NotificationDirectory>(
    base + "/notifications?state=all",
  );
  const companyRecord = initial.items.find(
    (row) => row.companyId === company.id,
  )!;
  const publicRecord = initial.items.find((row) => row.companyId === null)!;
  assert(companyRecord && publicRecord && initial.total === 2);
  const employeeContext = await browser.newContext({
    baseURL: origin,
    storageState: await employeeApi.storageState(),
    viewport: { width: 390, height: 844 },
  });
  const page = await employeeContext.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/notifications");
  const companyCard = page.locator(
    `[data-notification-id="${companyRecord.id}"]`,
  );
  const publicCard = page.locator(
    `[data-notification-id="${publicRecord.id}"]`,
  );
  await companyCard
    .getByText("تنبيه الشركة الأولى فقط", { exact: true })
    .waitFor();
  await publicCard
    .getByRole("heading", { name: "تغيير كلمة المرور", exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("تنبيه الشركة الثانية فقط", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("link", { name: "التنبيهات، 2 غير مقروء", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "أنواع التنبيهات", exact: true })
      .count(),
    0,
  );
  await companyCard.getByRole("button", { name: "مقروء", exact: true }).click();
  await page.getByText("تم تحديد التنبيه كمقروء.", { exact: true }).waitFor();
  await companyCard
    .getByText("مقروء · قيد المتابعة", { exact: true })
    .waitFor();
  assert(
    await companyCard
      .getByRole("button", { name: "إنجاز", exact: true })
      .isVisible(),
  );
  await page
    .getByRole("link", { name: "التنبيهات، 1 غير مقروء", exact: true })
    .waitFor();
  await companyCard.getByRole("button", { name: "تأجيل", exact: true }).click();
  const actionDialog = page.getByRole("dialog");
  await actionDialog
    .getByLabel("موعد المتابعة بتوقيت عدن", { exact: true })
    .fill(
      new Date(Date.now() + 2 * 86400000 + 3 * 3600000)
        .toISOString()
        .slice(0, 16),
    );
  await actionDialog.getByRole("button", { name: "حفظ", exact: true }).click();
  await page
    .getByText("تم تأجيل المتابعة إلى الموعد المحدد.", { exact: true })
    .waitFor();
  await companyCard.waitFor({ state: "detached" });
  async function filterState(state: string) {
    const loaded = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api" + base + "/notifications" &&
        url.searchParams.get("state") === state &&
        response.status() === 200
      );
    });
    await page.getByLabel("الحالة", { exact: true }).selectOption(state);
    await loaded;
    await page
      .locator('.notification-list[aria-busy="true"]')
      .waitFor({ state: "hidden" });
  }
  await filterState("snoozed");
  await companyCard.getByText(/موعد المتابعة:/).waitFor();
  assert.equal(await page.locator("[data-notification-id]").count(), 1);
  await companyCard.getByRole("button", { name: "إنجاز", exact: true }).click();
  await page.getByText("تم إنجاز متابعة التنبيه.", { exact: true }).waitFor();
  await companyCard.waitFor({ state: "detached" });
  await filterState("done");
  await companyCard.getByText(/منجز:/).waitFor();
  assert.equal(
    await companyCard
      .getByRole("button", { name: "إنجاز", exact: true })
      .count(),
    0,
  );
  await filterState("active");
  await publicCard
    .getByRole("heading", { name: "تغيير كلمة المرور", exact: true })
    .waitFor();
  await publicCard.getByRole("button", { name: "إنجاز", exact: true }).click();
  await page.getByText("تم إنجاز متابعة التنبيه.", { exact: true }).waitFor();
  await page
    .getByRole("link", { name: "التنبيهات، 0 غير مقروء", exact: true })
    .waitFor();
  await page
    .getByRole("heading", {
      name: "لا توجد تنبيهات في هذه القائمة",
      exact: true,
    })
    .waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Mobile notifications must not overflow the viewport",
  );
  await page.goto(otherBase + "/notifications");
  await page.getByText("تنبيه الشركة الثانية فقط", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("تنبيه الشركة الأولى فقط", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("link", { name: "التنبيهات، 1 غير مقروء", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: notification template settings/followers, planned activation guard, public/company isolation, mobile read/snooze/completion, filters and bell counts",
  );
  await ownerContext.close();
  await employeeContext.close();
} finally {
  await browser.close();
  await ownerApi.dispose();
  await employeeApi.dispose();
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
