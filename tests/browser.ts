import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createServer } from "node:net";
import {
  chromium,
  request,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { rolePermissionTemplates } from "../packages/contracts/src/index.ts";
import type {
  AppearancePreference,
  Account,
  AccountLink,
  AuditEvent,
  Branch,
  Company,
  CompanyCurrency,
  CompanyContext,
  Employee,
  ExchangeRate,
  FinanceSettings,
  Location,
  Page as ApiPage,
  SessionResponse,
  User,
} from "../packages/contracts/src/index.ts";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql:///tijara?host=%2Fworkspace%2F.tools%2Fpostgresql%2Fsocket&port=55432&user=agent";
const schema = `browser_${process.pid}_${Date.now()}`;
const password = "Browser-test-password-2026";
const originPort = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    assert(address && typeof address === "object");
    probe.close(() => resolve(address.port));
  });
});
const origin = `http://127.0.0.1:${originPort}`;

interface Actor {
  context: APIRequestContext;
  session: SessionResponse;
}
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
  const actor = {
    context: context ?? (await request.newContext({ baseURL: origin })),
    session: { user: null, csrf: null } as SessionResponse,
  };
  actor.session = await call<SessionResponse>(actor, "/auth/login", "POST", {
    email,
    password,
  });
  assert(actor.session.user);
  return actor;
}
async function register(index: number): Promise<User> {
  const actor = {
    context: await request.newContext({ baseURL: origin }),
    session: { user: null, csrf: null } as SessionResponse,
  };
  try {
    const session = await call<SessionResponse>(
      actor,
      "/auth/register",
      "POST",
      {
        name: `Employee ${String(index).padStart(2, "0")}`,
        displayName: `Display ${String(index).padStart(2, "0")}`,
        email: `person-${index}@browser.test`,
        phone: `+1555000${String(index).padStart(3, "0")}`,
        password,
      },
    );
    assert(session.user);
    return session.user;
  } finally {
    await actor.context.dispose();
  }
}

const failures: string[] = [];
let passed = 0;
let browser: Browser | undefined;
let server: Server | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const contexts: BrowserContext[] = [];
const apiContexts: APIRequestContext[] = [];
const pageErrors: string[] = [];

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`, error);
    const page = contexts.at(-1)?.pages().at(-1);
    if (page) console.error(`Failure page: ${page.url()}`);
    if (page && !page.isClosed())
      await page
        .screenshot({
          path: `/tmp/tijara-browser-failure-${failures.length}.png`,
          fullPage: true,
        })
        .catch(() => {});
  }
}
async function pageFor(
  email = "owner@browser.test",
  mobile = false,
): Promise<{ page: Page; actor: Actor; context: BrowserContext }> {
  assert(browser);
  const context = await browser.newContext({
    baseURL: origin,
    timezoneId: "UTC",
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  context.setDefaultTimeout(8000);
  contexts.push(context);
  const actor = await actorFor(email, context.request);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { page, actor, context };
}
async function rowIds(page: Page): Promise<number[]> {
  return page
    .locator("tbody tr[data-row-id]")
    .evaluateAll((rows) =>
      rows.map((row) => Number(row.getAttribute("data-row-id"))),
    );
}
async function selectedIds(page: Page): Promise<number[]> {
  return page
    .locator('tbody tr[aria-selected="true"]')
    .evaluateAll((rows) =>
      rows.map((row) => Number(row.getAttribute("data-row-id"))),
    );
}
async function waitRows(page: Page, expected: number[]): Promise<void> {
  await eventually(
    () => rowIds(page),
    (ids) => assert.deepEqual(ids, expected),
  );
}
async function openAppearance(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "إعدادات المظهر", exact: true })
    .click();
  await page.getByTestId("appearance-color").waitFor();
}
async function appearanceIs(
  page: Page,
  preference: AppearancePreference,
): Promise<void> {
  await eventually(
    async () => ({
      mode: await page.getByTestId("appearance-mode").inputValue(),
      color: await page.getByTestId("appearance-color").inputValue(),
    }),
    (value) => assert.deepEqual(value, preference),
  );
}
async function setAppearance(
  page: Page,
  preference: AppearancePreference,
  save = true,
): Promise<void> {
  await page.getByTestId("appearance-mode").selectOption(preference.mode);
  await page.getByTestId("appearance-color").fill(preference.color);
  if (save) {
    await page.getByTestId("appearance-save").click();
    await page
      .getByTestId("appearance-status")
      .getByText("تم حفظ المظهر لهذا النطاق", { exact: true })
      .waitFor();
  }
}
async function closeDialog(page: Page): Promise<void> {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "إغلاق النافذة" })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}
async function logoutToPublic(page: Page, actor: Actor): Promise<void> {
  await page.getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
  await eventually(
    () => call<SessionResponse>(actor, "/auth/session"),
    (value) => {
      assert.equal(
        value.user,
        null,
        "Logout must invalidate the actual server session",
      );
      assert.equal(value.csrf, null);
    },
  );
  await page.waitForURL(origin + "/");
  await page.getByRole("heading", { name: "تجارة", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(
    await page.locator(".scope-title strong").textContent(),
    "الموقع العام",
  );
  assert.equal(await page.locator(".company-nav-label").count(), 0);
  // Keep the mounted session provider: reloading here would hide a stuck logout intent.
  await page.evaluate(() => {
    window.history.pushState(
      { ...window.history.state, idx: (window.history.state?.idx ?? 0) + 1 },
      "",
      "/profile",
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForURL(origin + "/login");
  await page
    .getByRole("heading", { name: "تسجيل الدخول", exact: true })
    .waitFor();
}
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => void,
  timeout = 8000,
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
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function searchLookup(
  page: Page,
  container: Page | Locator,
  label: string,
  resource: string,
  query: string,
  id: number,
): Promise<void> {
  const searched = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === `/api${resource}` &&
      url.searchParams.get("q") === query
    );
  });
  await container.getByLabel(`بحث عن ${label}`, { exact: true }).fill(query);
  const response = await searched;
  assert(response.ok(), `Server lookup ${label} must succeed`);
  const result = (await response.json()) as ApiPage<{ id: number }>;
  assert(
    result.items.some((item) => item.id === id),
    `${label} must find the selected record through its server search`,
  );
  assert.equal(new URL(response.url()).searchParams.get("pageSize"), "20");
  const select = container.getByLabel(label, { exact: true });
  await select.locator(`option[value="${id}"]`).waitFor({ state: "attached" });
  await select.selectOption(String(id));
}
function rgb(value: string): [number, number, number] {
  const channels = value
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  assert(
    channels?.length === 3,
    `Expected computed RGB color, received ${value}`,
  );
  return channels as [number, number, number];
}
function contrast(foreground: string, background: string): number {
  const luminance = (color: string): number =>
    rgb(color).reduce((sum, channel, index) => {
      const unit = channel / 255;
      return (
        sum +
        (unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][index]!
      );
    }, 0);
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
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
    name: "Browser Owner",
    displayName: "Browser Owner",
    email: "owner@browser.test",
    password,
  });
  server = app.app.listen(originPort, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const owner = await actorFor("owner@browser.test");
  apiContexts.push(owner.context);
  const users: User[] = [];
  for (let index = 0; index < 32; index++) users.push(await register(index));
  const companyA = (
    await call<{ company: Company }>(owner, "/companies", "POST", {
      name: "Alpha Browser Company",
      phone: "+1555999001",
      address: "Alpha address",
    })
  ).company;
  const companyB = (
    await call<{ company: Company }>(owner, "/companies", "POST", {
      name: "Beta Browser Company",
      phone: "+1555999002",
      address: "Beta address",
    })
  ).company;
  const employees: Employee[] = [];
  for (let index = 0; index < 30; index++) {
    const user = users[index]!;
    employees.push(
      (
        await call<{ employee: Employee }>(
          owner,
          `/companies/${companyA.id}/employees`,
          "POST",
          {
            userId: user.id,
            name:
              index === 0
                ? `Employee 00 ${"long accessible text ".repeat(5)}`
                : `Employee ${String(index).padStart(2, "0")}`,
            phone: user.phone,
            role: index % 2 ? "sales" : "accountant",
            active: true,
            permissions: ["employees.view"],
          },
        )
      ).employee,
    );
  }
  for (const employee of employees.slice(0, 2))
    await call(
      owner,
      `/companies/${companyA.id}/employees/${employee.id}/manager`,
      "PATCH",
      { isGeneralManager: true },
    );

  // Scenarios below exercise the real isolated application; only race regressions intercept the endpoint under test.

  await scenario(
    "public registration, canonical profile and stored audit values",
    async () => {
      assert(browser);
      const context = await browser.newContext({
        baseURL: origin,
        viewport: { width: 1440, height: 1000 },
      });
      context.setDefaultTimeout(8000);
      contexts.push(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("/register");
      await page.getByLabel("الاسم", { exact: true }).fill("Profile Person");
      await page
        .getByLabel("اسم الظهور", { exact: true })
        .fill("Profile Display");
      await page
        .getByLabel("البريد الإلكتروني", { exact: true })
        .fill("profile.person@browser.test");
      await page.getByLabel("الهاتف", { exact: true }).fill("+1555888001");
      await page.getByLabel("كلمة المرور", { exact: true }).fill(password);
      await page
        .getByRole("button", { name: "إنشاء الحساب", exact: true })
        .click();
      await page.waitForURL(origin + "/");
      const actor: Actor = {
        context: context.request,
        session: { user: null, csrf: null },
      };
      actor.session = await call<SessionResponse>(actor, "/auth/session");
      assert.equal(actor.session.user?.owner, false);
      assert.equal(
        (await call<ApiPage<Company>>(actor, "/companies")).total,
        0,
        "Registration must not create company membership",
      );
      await page.goto("/profile");
      await page
        .getByLabel("الاسم", { exact: true })
        .fill("  Canonical Person  ");
      await page.getByLabel("اسم الظهور", { exact: true }).fill("   ");
      await page
        .getByLabel("البريد الإلكتروني", { exact: true })
        .fill("PROFILE.PERSON@browser.test");
      await page
        .getByLabel("الهاتف", { exact: true })
        .fill("+١ (٥٥٥) ٠١٢-٣٤٥٦");
      await page
        .getByRole("button", { name: "حفظ البيانات", exact: true })
        .click();
      await page.getByText("حُفظت بيانات الحساب.", { exact: true }).waitFor();
      const stored = await call<SessionResponse>(actor, "/auth/session");
      assert(stored.user);
      assert.equal(stored.user.name, "Canonical Person");
      assert.equal(stored.user.displayName, "Canonical Person");
      assert.equal(stored.user.email, "profile.person@browser.test");
      assert.equal(stored.user.phone, "+15550123456");
      assert.equal(
        await page.getByLabel("اسم الظهور", { exact: true }).inputValue(),
        stored.user.displayName,
      );
      const events = await call<ApiPage<AuditEvent>>(
        owner,
        "/audit?pageSize=100&sort=id:desc",
      );
      const event = events.items.find(
        (item) =>
          item.targetType === "user" &&
          item.targetId === stored.user!.id &&
          item.action.includes("profile"),
      );
      assert(event?.after, "Profile mutation must produce an audit event");
      for (const key of ["name", "displayName", "email", "phone"] as const)
        assert.equal(event.after[key], stored.user[key]);
      assert.equal(event.before?.name, "Profile Person");
      assert(
        !JSON.stringify(event).includes(password),
        "Secrets must not appear in audit output",
      );
      await page.reload();
      assert.equal(
        await page.getByLabel("اسم الظهور", { exact: true }).inputValue(),
        "Canonical Person",
      );
    },
  );

  await scenario(
    "owner creates company, links employees by ID and appoints multiple managers",
    async () => {
      const { page, actor } = await pageFor();
      await page.goto("/companies");
      await page
        .getByRole("button", { name: "إنشاء شركة", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("اسم الشركة", { exact: true })
        .fill("  Created Through Browser  ");
      await dialog
        .getByLabel("هاتف الشركة", { exact: true })
        .fill("+١ (٥٥٥) ٩٩٩-٠٠٣٣");
      await dialog
        .getByLabel("العنوان", { exact: true })
        .fill("  Canonical browser address  ");
      await dialog
        .getByRole("button", { name: "إنشاء الشركة", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await page
        .getByRole("link", { name: "Created Through Browser", exact: true })
        .waitFor();
      const created = (
        await call<ApiPage<Company>>(
          actor,
          "/companies?q=Created%20Through%20Browser",
        )
      ).items[0]!;
      assert.equal(created.phone, "+15559990033");
      assert.equal(created.address, "Canonical browser address");
      await page.getByRole("link", { name: created.name, exact: true }).click();
      await page.goto(`/companies/${created.id}/employees`);
      for (const index of [30, 31]) {
        await page
          .getByRole("button", { name: "إضافة موظف", exact: true })
          .click();
        const editor = page.getByRole("dialog");
        await editor
          .getByLabel("البريد أو هاتف الحساب العام")
          .fill(users[index]!.email);
        await editor
          .getByRole("button", { name: "البحث عن حساب", exact: true })
          .click();
        await editor.getByRole("radio").check();
        await editor
          .getByLabel("اسم الموظف", { exact: true })
          .fill(`Linked Employee ${index}`);
        await editor
          .getByLabel("هاتف الموظف", { exact: true })
          .fill(`+15551110${index}`);
        await editor
          .getByLabel("الدور", { exact: true })
          .selectOption(index === 30 ? "administrative" : "accountant");
        await editor
          .getByRole("button", { name: "إضافة الموظف", exact: true })
          .click();
        await editor.waitFor({ state: "hidden" });
        await page
          .getByRole("button", {
            name: `تعيين مدير عام Linked Employee ${index}`,
            exact: true,
          })
          .click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "تأكيد التعيين", exact: true })
          .click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await page
          .getByRole("button", {
            name: `سحب صفة المدير العام من Linked Employee ${index}`,
            exact: true,
          })
          .waitFor();
      }
      const linked = (
        await call<ApiPage<Employee>>(
          actor,
          `/companies/${created.id}/employees`,
        )
      ).items;
      assert.deepEqual(
        linked.map((item) => item.userId).sort((a, b) => a - b),
        [users[30]!.id, users[31]!.id],
      );
      assert(linked.every((item) => item.active && item.isGeneralManager));
      assert.equal(
        linked.find((item) => item.userId === users[30]!.id)?.role,
        "administrative",
      );
      assert.deepEqual(
        linked.find((item) => item.userId === users[30]!.id)?.permissions,
        [...rolePermissionTemplates.administrative].sort(),
      );
      const manager = await pageFor(users[30]!.email);
      await manager.page.goto(`/companies/${created.id}/employees`);
      await waitRows(
        manager.page,
        linked.map((item) => item.id),
      );
      assert.equal(
        await manager.page
          .getByRole("button", { name: /تعيين مدير عام|سحب صفة المدير العام/ })
          .count(),
        0,
        "Manager appointment controls are owner-only",
      );
      assert.equal(
        await manager.page
          .getByRole("button", {
            name: "تعديل Linked Employee 31",
            exact: true,
          })
          .count(),
        0,
        "A manager cannot change another manager",
      );
    },
  );

  await scenario(
    "company access uses active membership and denies cross-company direct navigation",
    async () => {
      const { page, actor } = await pageFor(users[2]!.email);
      await page.goto(`/companies/${companyA.id}/employees`);
      await eventually(
        () => rowIds(page),
        (ids) => assert.equal(ids.length, 20),
      );
      await eventually(
        () =>
          call<ApiPage<Company> & { lastCompanyId: number | null }>(
            actor,
            "/companies",
          ),
        (value) =>
          assert.equal(
            value.lastCompanyId,
            companyA.id,
            "Company activation must persist the last available company",
          ),
      );
      assert.equal(
        await page
          .getByRole("button", { name: "إضافة موظف", exact: true })
          .count(),
        0,
      );
      const denied = await actor.context.get(`/api/companies/${companyB.id}`);
      assert.equal(denied.status(), 403);
      await page.goto(`/companies/${companyB.id}/overview`);
      await page.getByRole("alert").waitFor();
      assert.equal(
        await page
          .getByRole("heading", { name: companyB.name, exact: true })
          .count(),
        0,
      );
      await page.goto("/companies");
      await page
        .getByRole("link", { name: companyA.name, exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("link", { name: companyB.name, exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "إنشاء شركة", exact: true })
          .count(),
        0,
      );
      await page.locator(".sidebar .company-nav-label").getByText(companyA.name, { exact: true }).waitFor();
      await page.goto("/profile");
      await page.locator(".sidebar .company-nav-label").getByText(companyA.name, { exact: true }).waitFor();
      assert.equal(await page.locator(`.sidebar a[href="/companies/${companyA.id}/employees"]`).count(), 1);
      await page.reload();
      await page.locator(".sidebar .company-nav-label").getByText(companyA.name, { exact: true }).waitFor();
      assert.equal(await page.locator(`.sidebar a[href="/companies/${companyB.id}/employees"]`).count(), 0);
    },
  );

  await scenario(
    "server pagination, row sorting and multisort priority remain stable",
    async () => {
      const { page, actor } = await pageFor();
      await page.goto(`/companies/${companyA.id}/employees`);
      const initial = await call<ApiPage<Employee>>(
        actor,
        `/companies/${companyA.id}/employees?pageSize=20&sort=id:asc`,
      );
      assert.equal(initial.total, 30);
      await waitRows(
        page,
        initial.items.map((item) => item.id),
      );
      await page
        .getByRole("button", { name: "الصفحة التالية", exact: true })
        .click();
      const second = await call<ApiPage<Employee>>(
        actor,
        `/companies/${companyA.id}/employees?page=2&pageSize=20&sort=id:asc`,
      );
      await waitRows(
        page,
        second.items.map((item) => item.id),
      );
      assert.equal(new URL(page.url()).searchParams.get("page"), "2");
      assert(
        initial.items.every(
          (item) => !second.items.some((other) => other.id === item.id),
        ),
        "Pagination must not duplicate first-page rows",
      );
      await page.locator('th[data-column-id="role"] button').click();
      await page
        .locator('th[data-column-id="name"] button')
        .click({ modifiers: ["Shift"] });
      await page
        .locator('th[data-column-id="role"] button')
        .click({ modifiers: ["Shift"] });
      await eventually(
        async () => new URL(page.url()).searchParams.get("sort"),
        (value) => assert.equal(value, "role:desc,name:asc"),
      );
      assert.equal(
        await page
          .locator('th[data-column-id="role"]')
          .getAttribute("data-sort-priority"),
        "1",
      );
      assert.equal(
        await page
          .locator('th[data-column-id="name"]')
          .getAttribute("data-sort-priority"),
        "2",
      );
      const sorted = await call<ApiPage<Employee>>(
        actor,
        `/companies/${companyA.id}/employees?pageSize=20&sort=role:desc,name:asc`,
      );
      await waitRows(
        page,
        sorted.items.map((item) => item.id),
      );
      assert.equal(sorted.items[0]!.role, "sales");
      await page.reload();
      await waitRows(
        page,
        sorted.items.map((item) => item.id),
      );
      await page
        .getByLabel("الدور", { exact: true })
        .selectOption("accountant");
      const filtered = await call<ApiPage<Employee>>(
        actor,
        `/companies/${companyA.id}/employees?pageSize=20&sort=role:desc,name:asc&role=accountant`,
      );
      assert.equal(filtered.total, 15);
      await waitRows(
        page,
        filtered.items.map((item) => item.id),
      );
      await page
        .getByLabel("بحث في الموظفين", { exact: true })
        .fill("Employee 28");
      await waitRows(page, [employees[28]!.id]);
    },
  );

  await scenario(
    "OS, multiple and single selection use stable record IDs and select only the page",
    async () => {
      const { page, actor } = await pageFor();
      await page.goto(`/companies/${companyA.id}/employees`);
      await waitRows(
        page,
        employees.slice(0, 20).map((item) => item.id),
      );
      const rows = page.locator("tbody tr[data-row-id]");
      await rows
        .nth(0)
        .locator("td.selection-cell")
        .click({ position: { x: 2, y: 5 } });
      assert.deepEqual(await selectedIds(page), [employees[0]!.id]);
      await rows
        .nth(2)
        .locator("td.selection-cell")
        .click({ position: { x: 2, y: 5 }, modifiers: ["Control"] });
      assert.deepEqual(await selectedIds(page), [
        employees[0]!.id,
        employees[2]!.id,
      ]);
      await rows
        .nth(4)
        .locator("td.selection-cell")
        .click({ position: { x: 2, y: 5 }, modifiers: ["Shift"] });
      assert.deepEqual(await selectedIds(page), [
        employees[0]!.id,
        employees[2]!.id,
        employees[3]!.id,
        employees[4]!.id,
      ]);
      await page
        .getByRole("checkbox", {
          name: "اختيار كل سجلات الصفحة الحالية فقط",
          exact: true,
        })
        .check();
      assert.deepEqual(
        await selectedIds(page),
        employees.slice(0, 20).map((item) => item.id),
      );
      await page
        .getByRole("button", { name: "الصفحة التالية", exact: true })
        .click();
      await waitRows(
        page,
        employees.slice(20).map((item) => item.id),
      );
      assert.deepEqual(
        await selectedIds(page),
        [],
        "Select-all must not select future pages",
      );
      await page
        .getByRole("button", { name: "الصفحة السابقة", exact: true })
        .click();
      await waitRows(
        page,
        employees.slice(0, 20).map((item) => item.id),
      );
      assert.deepEqual(
        await selectedIds(page),
        employees.slice(0, 20).map((item) => item.id),
        "Selection follows IDs across page navigation",
      );
      await page.locator('th[data-column-id="name"] button').click();
      await page.locator('th[data-column-id="name"] button').click();
      const descending = await call<ApiPage<Employee>>(
        actor,
        `/companies/${companyA.id}/employees?pageSize=20&sort=name:desc`,
      );
      await waitRows(
        page,
        descending.items.map((item) => item.id),
      );
      const selected = new Set(employees.slice(0, 20).map((item) => item.id));
      assert.deepEqual(
        await selectedIds(page),
        descending.items
          .filter((item) => selected.has(item.id))
          .map((item) => item.id),
        "Reordered visible selection must follow record IDs",
      );
      assert.deepEqual(
        (await page.locator(".data-table").getAttribute("data-selected-ids"))!
          .split(",")
          .map(Number)
          .sort((a, b) => a - b),
        [...selected].sort((a, b) => a - b),
      );
      await page.goto("/users");
      await eventually(
        () => rowIds(page),
        (ids) => assert(ids.length > 1),
      );
      const userIds = await rowIds(page);
      await page
        .getByRole("checkbox", {
          name: `اختيار السجل ${userIds[0]}`,
          exact: true,
        })
        .check();
      await page
        .getByRole("checkbox", {
          name: `اختيار السجل ${userIds[1]}`,
          exact: true,
        })
        .check();
      assert.deepEqual(await selectedIds(page), userIds.slice(0, 2));
      assert.equal(
        await page
          .locator("tbody select")
          .first()
          .evaluate((element) => getComputedStyle(element).fontSize),
        "14px",
        "Select controls inside cells must retain the shared readable input font",
      );
      assert(
        (
          await page
            .locator("tbody tr")
            .evaluateAll((rows) =>
              rows.map((row) => row.getBoundingClientRect().height),
            )
        ).every((height) => Math.abs(height - 34) < 0.5),
        "Rows containing inline Select controls must remain exactly 34px",
      );
      await page.screenshot({
        path: "/tmp/tijara-browser-users.png",
        fullPage: true,
      });
      await page.goto("/audit");
      await eventually(
        () => rowIds(page),
        (ids) => assert(ids.length > 1),
      );
      const auditIds = await rowIds(page);
      await page
        .getByRole("radio", {
          name: `اختيار السجل ${auditIds[0]}`,
          exact: true,
        })
        .check();
      await page
        .getByRole("radio", {
          name: `اختيار السجل ${auditIds[1]}`,
          exact: true,
        })
        .check();
      assert.deepEqual(await selectedIds(page), [auditIds[1]]);
    },
  );

  await scenario(
    "appearance persists independently for public, each company and each user",
    async () => {
      const { page, actor } = await pageFor();
      const preferences: Array<[string, string, AppearancePreference]> = [
        ["/", "public", { mode: "light", color: "#ff00ff" }],
        [
          `/companies/${companyA.id}/employees`,
          `company:${companyA.id}`,
          { mode: "dark", color: "#ffff00" },
        ],
        [
          `/companies/${companyB.id}`,
          `company:${companyB.id}`,
          { mode: "light", color: "#00ffff" },
        ],
      ];
      for (const [path, scope, preference] of preferences) {
        await page.goto(path);
        await openAppearance(page);
        await page
          .getByText("جارٍ تحميل المظهر…", { exact: true })
          .waitFor({ state: "hidden" });
        await setAppearance(page, preference);
        assert.deepEqual(
          (
            await call<{ preference: AppearancePreference }>(
              actor,
              `/appearance?scope=${encodeURIComponent(scope)}`,
            )
          ).preference,
          preference,
        );
        await closeDialog(page);
      }
      for (const [path, , preference] of preferences) {
        await page.goto(path);
        await openAppearance(page);
        await appearanceIs(page, preference);
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          preference.mode,
        );
        await closeDialog(page);
      }
      await logoutToPublic(page, actor);
      await page.goto("/login");
      await page
        .getByLabel("البريد الإلكتروني", { exact: true })
        .fill(users[2]!.email);
      await page.getByLabel("كلمة المرور", { exact: true }).fill(password);
      await page
        .getByRole("button", { name: "تسجيل الدخول", exact: true })
        .click();
      await page.waitForURL(origin + "/");
      const nextActor: Actor = {
        context: actor.context,
        session: await call<SessionResponse>(actor, "/auth/session"),
      };
      assert.equal(nextActor.session.user?.id, users[2]!.id);
      const publicDefault = (
        await call<{ preference: AppearancePreference }>(
          nextActor,
          "/appearance?scope=public",
        )
      ).preference;
      const companyDefault = (
        await call<{ preference: AppearancePreference }>(
          nextActor,
          `/appearance?scope=company:${companyA.id}`,
        )
      ).preference;
      assert.notDeepEqual(publicDefault, preferences[0]![2]);
      assert.notDeepEqual(companyDefault, preferences[1]![2]);
      await openAppearance(page);
      await appearanceIs(page, publicDefault);
      await closeDialog(page);
      await page.goto(`/companies/${companyA.id}/employees`);
      await openAppearance(page);
      await appearanceIs(page, companyDefault);
    },
  );

  await scenario(
    "rendered desktop and mobile geometry, RTL, full values and drawer keyboard/touch behavior",
    async () => {
      for (const mobile of [false, true]) {
        const { page, actor } = await pageFor("owner@browser.test", mobile);
        await page.goto(`/companies/${companyA.id}/employees`);
        await waitRows(
          page,
          employees.slice(0, 20).map((item) => item.id),
        );
        await page.screenshot({
          path: `/tmp/tijara-browser-${mobile ? "mobile" : "desktop"}.png`,
          fullPage: true,
        });
        assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
        const geometry = await page.evaluate(() => {
          const field = document.querySelector<HTMLInputElement>(
            'input[type="search"]',
          )!;
          const pageSize =
            document.querySelector<HTMLSelectElement>(".pagination select")!;
          // Native selects reserve space for the arrow in addition to CSS padding.
          // Their intrinsic width includes every offered option and the real font.
          const intrinsicPageSize = pageSize.cloneNode(
            true,
          ) as HTMLSelectElement;
          Object.assign(intrinsicPageSize.style, {
            position: "absolute",
            visibility: "hidden",
            width: "max-content",
            maxWidth: "none",
          });
          pageSize.parentElement!.append(intrinsicPageSize);
          const minimumPageSizeWidth =
            intrinsicPageSize.getBoundingClientRect().width;
          intrinsicPageSize.remove();
          return {
            fieldHeight: field.getBoundingClientRect().height,
            font: getComputedStyle(field).fontSize,
            controls: [
              ...document.querySelectorAll<HTMLElement>(
                ".filter-bar input, .filter-bar select, .pagination select",
              ),
            ].map((element) => ({
              height: element.getBoundingClientRect().height,
              font: getComputedStyle(element).fontSize,
            })),
            pageSizeValue: pageSize.value,
            pageSizeText: pageSize.selectedOptions[0]!.textContent,
            pageSizeWidth: pageSize.getBoundingClientRect().width,
            minimumPageSizeWidth,
            rows: [...document.querySelectorAll("tbody tr")].map(
              (row) => row.getBoundingClientRect().height,
            ),
            sticky: getComputedStyle(document.querySelector("th")!).position,
            tableHeight: document
              .querySelector(".table-scroll")!
              .getBoundingClientRect().height,
          };
        });
        assert.equal(geometry.font, "14px");
        assert.equal(geometry.fieldHeight, mobile ? 38 : 32);
        assert(geometry.controls.length >= 4);
        for (const control of geometry.controls) {
          assert.equal(control.height, mobile ? 38 : 32);
          assert.equal(control.font, "14px");
        }
        assert.equal(geometry.pageSizeValue, "20");
        assert.equal(geometry.pageSizeText, "20");
        assert(
          geometry.pageSizeWidth >= geometry.minimumPageSizeWidth,
          `The page-size selector must show the full label beside its native arrow: ${geometry.pageSizeWidth}px < ${geometry.minimumPageSizeWidth}px`,
        );
        assert(
          geometry.rows.every(
            (height) => Math.abs(height - (mobile ? 38 : 34)) < 0.5,
          ),
          `Measured ${mobile ? "mobile" : "desktop"} row heights: ${geometry.rows.join(", ")}`,
        );
        assert.equal(geometry.sticky, "sticky");
        assert(
          geometry.tableHeight > 100 &&
            geometry.tableHeight < (mobile ? 844 : 1000),
        );
        const fullValue = page.locator(
          `tr[data-row-id="${employees[0]!.id}"] td[data-cell-id="name"] .table-value`,
        );
        assert(
          await fullValue
            .locator(".truncate")
            .evaluate((element) => element.scrollWidth > element.clientWidth),
          "Long row text must be truncated to preserve row height",
        );
        if (mobile) await fullValue.tap();
        else {
          await fullValue.focus();
          await page.keyboard.press("Enter");
        }
        await page
          .getByRole("dialog", { name: "القيمة الكاملة", exact: true })
          .waitFor();
        assert.equal(
          await page.getByRole("dialog").locator(".full-value").textContent(),
          employees[0]!.name,
        );
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        assert(
          await fullValue.evaluate(
            (element) => document.activeElement === element,
          ),
          "Dialog must restore keyboard focus",
        );
        if (mobile) {
          const trigger = page.getByRole("button", {
            name: "فتح قائمة التنقل",
            exact: true,
          });
          await trigger.tap();
          assert.equal(await trigger.getAttribute("aria-expanded"), "true");
          const drawer = page.getByRole("dialog", {
            name: "قائمة التنقل",
            exact: true,
          });
          await drawer.waitFor();
          await page.keyboard.press("Tab");
          assert(
            await drawer.evaluate((element) =>
              element.contains(document.activeElement),
            ),
            "Modal drawer traps keyboard focus",
          );
          await drawer.getByRole("link", { name: "حسابي", exact: true }).tap();
          await page.waitForURL(origin + "/profile");
          await drawer.waitFor({ state: "hidden" });
          assert.equal(await trigger.getAttribute("aria-expanded"), "false");
          const profileField = page.getByLabel("الاسم", { exact: true });
          assert.equal(
            await profileField.evaluate(
              (element) => element.getBoundingClientRect().height,
            ),
            38,
          );
          await trigger.tap();
          await page.keyboard.press("Escape");
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          assert(
            await trigger.evaluate(
              (element) => element === document.activeElement,
            ),
            "Drawer Escape returns focus to its trigger",
          );
        }
        await logoutToPublic(page, actor);
      }
    },
  );

  await scenario(
    "actual bright and dark rendered text/background contrast meets 4.5",
    async () => {
      const { page } = await pageFor();
      await page.goto(`/companies/${companyA.id}/employees`);
      await waitRows(
        page,
        employees.slice(0, 20).map((item) => item.id),
      );
      for (const mode of ["light", "dark"] as const)
        for (const color of ["#ffff00", "#00ffff", "#777777"]) {
          await openAppearance(page);
          await page
            .getByText("جارٍ تحميل المظهر…", { exact: true })
            .waitFor({ state: "hidden" });
          await setAppearance(page, { mode, color }, false);
          await closeDialog(page);
          const samples = await page.evaluate(() => {
            const selectors = [
              ".main-content h1",
              ".card h2",
              ".card p",
              ".nav-link.active",
              ".button-primary",
              'input[type="search"]',
              ".sort-button",
              ".table-value",
              ".notice-info",
            ];
            return selectors.flatMap((selector) => {
              const element = [
                ...document.querySelectorAll<HTMLElement>(selector),
              ].find((item) => item.getBoundingClientRect().height > 0);
              if (!element) return [];
              let ancestor: HTMLElement | null = element;
              let background = "rgba(0, 0, 0, 0)";
              while (ancestor) {
                background = getComputedStyle(ancestor).backgroundColor;
                if (
                  background !== "rgba(0, 0, 0, 0)" &&
                  background !== "transparent"
                )
                  break;
                ancestor = ancestor.parentElement;
              }
              return [
                {
                  selector,
                  foreground: getComputedStyle(element).color,
                  background,
                },
              ];
            });
          });
          assert(
            samples.length >= 7,
            "Contrast check must sample actual navigation, inputs, table and buttons",
          );
          for (const sample of samples) {
            const ratio = contrast(sample.foreground, sample.background);
            assert(
              ratio >= 4.5,
              `${mode} ${color} ${sample.selector}: ${sample.foreground} on ${sample.background} = ${ratio.toFixed(3)}`,
            );
          }
        }
    },
  );

  await scenario(
    "delayed public appearance fetch cannot overwrite company scope or newer local edits",
    async () => {
      const { page, actor } = await pageFor();
      const publicPreference: AppearancePreference = {
        mode: "dark",
        color: "#c2410c",
      };
      const companyPreference: AppearancePreference = {
        mode: "light",
        color: "#2563eb",
      };
      await call(actor, "/appearance", "PATCH", {
        scope: "public",
        ...publicPreference,
      });
      await call(actor, "/appearance", "PATCH", {
        scope: `company:${companyA.id}`,
        ...companyPreference,
      });
      const held = gate();
      let arrived = false;
      let completed = false;
      await page.route("**/api/appearance?*", async (route) => {
        if (
          route.request().method() !== "GET" ||
          new URL(route.request().url()).searchParams.get("scope") !== "public"
        )
          return route.continue();
        const response = await route.fetch();
        arrived = true;
        await held.promise;
        try {
          await route.fulfill({ response });
        } catch {
          /* A scope change may correctly abort the browser request. */
        }
        completed = true;
      });
      try {
        await page.goto("/companies");
        await eventually(
          async () => arrived,
          (value) => assert(value),
        );
        await page
          .getByRole("link", { name: companyA.name, exact: true })
          .click();
        await page.waitForURL(origin + `/companies/${companyA.id}`);
        await openAppearance(page);
        await appearanceIs(page, companyPreference);
        held.release();
        await eventually(
          async () => completed,
          (value) => assert(value),
        );
        await appearanceIs(page, companyPreference);
        assert.equal(new URL(page.url()).pathname, `/companies/${companyA.id}`);
        assert.deepEqual(
          (
            await call<{ preference: AppearancePreference }>(
              actor,
              `/appearance?scope=company:${companyA.id}`,
            )
          ).preference,
          companyPreference,
        );
      } finally {
        held.release();
        await page.unroute("**/api/appearance?*");
      }
      await closeDialog(page);
      const secondHeld = gate();
      let secondArrived = false;
      let secondCompleted = false;
      await page.route("**/api/appearance?*", async (route) => {
        const response = await route.fetch();
        secondArrived = true;
        await secondHeld.promise;
        try {
          await route.fulfill({ response });
        } catch {
          /* Expected if request is canceled. */
        }
        secondCompleted = true;
      });
      try {
        await page.goto("/");
        await eventually(
          async () => secondArrived,
          (value) => assert(value),
        );
        await openAppearance(page);
        const edited: AppearancePreference = {
          mode: "light",
          color: "#00aacc",
        };
        await setAppearance(page, edited, false);
        secondHeld.release();
        await eventually(
          async () => secondCompleted,
          (value) => assert(value),
        );
        await page
          .getByText("جارٍ تحميل المظهر…", { exact: true })
          .waitFor({ state: "hidden" });
        await appearanceIs(page, edited);
        assert.equal(
          await page.getByTestId("appearance-revision").textContent(),
          "تغييرات غير محفوظة",
        );
        assert.deepEqual(
          (
            await call<{ preference: AppearancePreference }>(
              actor,
              "/appearance?scope=public",
            )
          ).preference,
          publicPreference,
          "Local edits must not persist without a save",
        );
      } finally {
        secondHeld.release();
        await page.unroute("**/api/appearance?*");
      }
    },
  );

  await scenario(
    "delayed appearance save preserves unsent edits and cannot cross scopes",
    async () => {
      const { page, actor } = await pageFor();
      await call(actor, "/appearance", "PATCH", {
        scope: "public",
        mode: "light",
        color: "#176b61",
      });
      const companyPreference: AppearancePreference = {
        mode: "dark",
        color: "#654321",
      };
      await call(actor, "/appearance", "PATCH", {
        scope: `company:${companyA.id}`,
        ...companyPreference,
      });
      await page.goto("/companies");
      await openAppearance(page);
      await appearanceIs(page, { mode: "light", color: "#176b61" });
      const held = gate();
      let arrived = false;
      let completed = false;
      let sent: unknown;
      await page.route("**/api/appearance", async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        sent = route.request().postDataJSON();
        const response = await route.fetch();
        assert(response.ok());
        arrived = true;
        await held.promise;
        try {
          await route.fulfill({ response });
        } catch {
          /* Expected cancellation after a scope change. */
        }
        completed = true;
      });
      try {
        const original: AppearancePreference = {
          mode: "dark",
          color: "#ee0000",
        };
        const newer: AppearancePreference = { mode: "light", color: "#00aacc" };
        await setAppearance(page, original, false);
        await page.getByTestId("appearance-save").click();
        await eventually(
          async () => arrived,
          (value) => assert(value),
        );
        await setAppearance(page, newer, false);
        held.release();
        await eventually(
          async () => completed,
          (value) => assert(value),
        );
        await page
          .getByTestId("appearance-status")
          .getByText(
            "تم حفظ النسخة المرسلة. توجد تغييرات أحدث تحتاج إلى حفظ.",
            { exact: true },
          )
          .waitFor();
        await appearanceIs(page, newer);
        assert.equal(
          await page.getByTestId("appearance-revision").textContent(),
          "تغييرات غير محفوظة",
        );
        assert.deepEqual(sent, { scope: "public", ...original });
        assert.deepEqual(
          (
            await call<{ preference: AppearancePreference }>(
              actor,
              "/appearance?scope=public",
            )
          ).preference,
          original,
        );
      } finally {
        held.release();
        await page.unroute("**/api/appearance");
      }
      await closeDialog(page);
      const navigationHeld = gate();
      let navigationArrived = false;
      let navigationCompleted = false;
      await page.route("**/api/appearance", async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        const response = await route.fetch();
        navigationArrived = true;
        await navigationHeld.promise;
        try {
          await route.fulfill({ response });
        } catch {
          /* Expected cancellation. */
        }
        navigationCompleted = true;
      });
      try {
        await openAppearance(page);
        await setAppearance(page, { mode: "light", color: "#aabbcc" }, false);
        await page.getByTestId("appearance-save").click();
        await eventually(
          async () => navigationArrived,
          (value) => assert(value),
        );
        await closeDialog(page);
        await page
          .getByRole("link", { name: companyA.name, exact: true })
          .click();
        await page.waitForURL(origin + `/companies/${companyA.id}`);
        await openAppearance(page);
        await appearanceIs(page, companyPreference);
        navigationHeld.release();
        await eventually(
          async () => navigationCompleted,
          (value) => assert(value),
        );
        await appearanceIs(page, companyPreference);
        assert.equal(
          await page.getByTestId("appearance-status").textContent(),
          "",
        );
        assert.deepEqual(
          (
            await call<{ preference: AppearancePreference }>(
              actor,
              `/appearance?scope=company:${companyA.id}`,
            )
          ).preference,
          companyPreference,
        );
        assert.deepEqual(
          (
            await call<{ preference: AppearancePreference }>(
              actor,
              "/appearance?scope=public",
            )
          ).preference,
          { mode: "light", color: "#aabbcc" },
        );
      } finally {
        navigationHeld.release();
        await page.unroute("**/api/appearance");
      }
    },
  );

  await scenario(
    "late company save persists canonical data without resurrecting company after navigation",
    async () => {
      const { page, actor } = await pageFor();
      await page.goto(`/companies/${companyA.id}/settings`);
      await page.getByLabel("اسم الشركة", { exact: true }).waitFor();
      const held = gate();
      let arrived = false;
      let completed = false;
      let sent: unknown;
      await page.route(`**/api/companies/${companyA.id}`, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        sent = route.request().postDataJSON();
        const response = await route.fetch();
        assert(response.ok());
        arrived = true;
        await held.promise;
        try {
          await route.fulfill({ response });
        } catch {
          /* Scope cancellation is the intended behavior. */
        }
        completed = true;
      });
      try {
        await page
          .getByLabel("اسم الشركة", { exact: true })
          .fill("  Canonical Late Company  ");
        await page
          .getByRole("button", { name: "حفظ البيانات", exact: true })
          .click();
        await eventually(
          async () => arrived,
          (value) => assert(value),
        );
        await page.locator('.sidebar a[href="/"]').first().click();
        await page.waitForURL(origin + "/");
        held.release();
        await eventually(
          async () => completed,
          (value) => assert(value),
        );
        assert.equal(new URL(page.url()).pathname, "/");
        assert.equal(
          await page.locator(".scope-title strong").textContent(),
          "الموقع العام",
        );
        await eventually(
          async () => page.locator(".sidebar .company-nav-label").textContent(),
          (name) => assert.equal(name, "Canonical Late Company"),
        );
        assert.equal(
          await page
            .getByText("تم حفظ بيانات الشركة.", { exact: true })
            .count(),
          0,
        );
        assert.equal(
          (sent as { name: string }).name,
          "  Canonical Late Company  ",
        );
        const stored = await call<CompanyContext>(
          actor,
          `/companies/${companyA.id}`,
        );
        assert.equal(stored.company.name, "Canonical Late Company");
        await page.locator('.sidebar a[href="/companies"]').click();
        await page
          .getByRole("link", { name: stored.company.name, exact: true })
          .waitFor();
        await page
          .getByRole("link", { name: stored.company.name, exact: true })
          .click();
        await page
          .getByRole("heading", { name: stored.company.name, exact: true })
          .waitFor();
        assert.equal(
          await page.locator(".scope-title strong").textContent(),
          stored.company.name,
        );
      } finally {
        held.release();
        await page.unroute(`**/api/companies/${companyA.id}`);
      }
    },
  );

  await scenario(
    "master data creates, edits and links real accounts, currencies, rates, branches and locations",
    async () => {
      const { page, actor } = await pageFor();
      const company = (
        await call<{ company: Company }>(actor, "/companies", "POST", {
          name: "Master Browser Company",
          phone: "",
          address: "",
        })
      ).company;
      const path = `/companies/${company.id}`;
      await page.goto(`${path}/accounts`);
      await page
        .getByRole("button", { name: "إضافة حساب", exact: true })
        .click();
      let dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("اسم الحساب", { exact: true })
        .fill("  Browser Assets  ");
      await dialog
        .getByLabel("نوع الحساب", { exact: true })
        .selectOption("group");
      await dialog.getByLabel("كود الحساب", { exact: true }).fill("٩٠٠٠٠٠٠٠٠٠");
      await dialog
        .getByLabel("بداية مجال الترقيم", { exact: true })
        .fill("9000000001");
      await dialog
        .getByLabel("نهاية مجال الترقيم", { exact: true })
        .fill("9000000999");
      await dialog
        .getByRole("button", { name: "حفظ الحساب", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const group = (
        await call<ApiPage<Account>>(actor, `${path}/accounts?kind=group`)
      ).items[0]!;
      assert.equal(group.code, "9000000000");
      assert.equal(group.name, "Browser Assets");
      assert.equal(group.rangeStart, "9000000001");
      await page
        .getByRole("button", { name: "إضافة حساب", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("اسم الحساب", { exact: true })
        .fill("Browser Inventory");
      await searchLookup(
        page,
        dialog,
        "المجموعة الأم",
        `${path}/accounts`,
        group.name,
        group.id,
      );
      await dialog
        .getByLabel("طريقة الترقيم", { exact: true })
        .selectOption("auto");
      await dialog
        .getByRole("button", { name: "حفظ الحساب", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const posting = (
        await call<ApiPage<Account>>(actor, `${path}/accounts?kind=posting`)
      ).items[0]!;
      assert.equal(posting.code, "9000000001");
      assert.equal(posting.parentId, group.id);
      await page
        .getByRole("button", {
          name: `تعديل الحساب ${posting.code}`,
          exact: true,
        })
        .click();
      dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("اسم الحساب", { exact: true })
        .fill("  Edited Browser Inventory  ");
      await dialog
        .getByRole("button", { name: "حفظ الحساب", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const editedAccount = (
        await call<{ account: Account }>(
          actor,
          `${path}/accounts/${posting.id}`,
        )
      ).account;
      assert.equal(editedAccount.name, "Edited Browser Inventory");
      assert.equal(editedAccount.code, posting.code);
      await page
        .getByRole("button", { name: "ربط المخزون", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await searchLookup(
        page,
        dialog,
        "حساب الربط",
        `${path}/accounts`,
        editedAccount.name,
        posting.id,
      );
      await dialog
        .getByRole("button", { name: "حفظ الربط", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        (
          await call<{ items: AccountLink[] }>(actor, `${path}/account-links`)
        ).items.find((link) => link.purpose === "inventory")?.accountId,
        posting.id,
      );

      await page.goto(`${path}/currencies`);
      await page
        .getByRole("button", { name: "تهيئة العملات", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      assert.equal(
        await dialog
          .getByLabel("العملة الأساسية المقترحة", { exact: true })
          .inputValue(),
        "YER",
      );
      await dialog
        .getByRole("button", { name: "تأكيد تهيئة العملات", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const settings = (
        await call<{ settings: FinanceSettings }>(
          actor,
          `${path}/finance-settings`,
        )
      ).settings;
      assert.equal(settings.baseCurrencyCode, "YER");
      assert.equal(
        (await call<ApiPage<ExchangeRate>>(actor, `${path}/exchange-rates`))
          .total,
        0,
        "Currency initialization must not invent exchange rates",
      );
      await page
        .getByRole("button", { name: "إضافة عملة", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("كود العملة", { exact: true }).fill("eur");
      await dialog
        .getByLabel("اسم العملة", { exact: true })
        .fill("  Browser Euro  ");
      await dialog
        .getByLabel("المنازل العشرية", { exact: true })
        .selectOption("4");
      await dialog
        .getByRole("button", { name: "إضافة العملة", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const currency = (
        await call<ApiPage<CompanyCurrency>>(actor, `${path}/currencies?q=EUR`)
      ).items[0]!;
      assert.equal(currency.code, "EUR");
      assert.equal(currency.name, "Browser Euro");
      assert.equal(currency.decimalPlaces, 4);
      await page
        .getByRole("button", { name: "تعديل EUR", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      assert.equal(
        await dialog
          .getByLabel("كود العملة", { exact: true })
          .getAttribute("readonly"),
        "",
      );
      assert(
        await dialog
          .getByLabel("المنازل العشرية", { exact: true })
          .isDisabled(),
      );
      await dialog
        .getByLabel("اسم العملة", { exact: true })
        .fill("Edited Browser Euro");
      await dialog
        .getByRole("button", { name: "حفظ العملة", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        (
          await call<{ currency: CompanyCurrency }>(
            actor,
            `${path}/currencies/${currency.id}`,
          )
        ).currency.name,
        "Edited Browser Euro",
      );

      await page.goto(`${path}/exchange-rates`);
      await page
        .getByRole("button", { name: "إضافة سعر صرف", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await searchLookup(
        page,
        dialog,
        "العملة الأجنبية",
        `${path}/currencies`,
        "EUR",
        currency.id,
      );
      await dialog.getByLabel("سعر الصرف", { exact: true }).fill("٥٣٠٫٢٥٠٠");
      await dialog
        .getByLabel("وقت سريان السعر", { exact: true })
        .fill("2026-10-01T12:30");
      assert.equal(
        await dialog
          .getByLabel("وقت سريان السعر", { exact: true })
          .inputValue(),
        "2026-10-01T12:30",
      );
      await dialog
        .getByLabel("مصدر السعر اليدوي", { exact: true })
        .fill("  Browser manual quote  ");
      await dialog
        .getByRole("button", { name: "حفظ سعر الصرف", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const rate = (
        await call<ApiPage<ExchangeRate>>(actor, `${path}/exchange-rates`)
      ).items[0]!;
      assert.equal(rate.rate, "530.25");
      assert.equal(rate.currencyId, currency.id);
      assert.equal(rate.baseCurrencyId, settings.baseCurrencyId);
      assert.equal(rate.effectiveAt, "2026-10-01T12:30:00.000Z");
      assert.equal(rate.source, "Browser manual quote");
      await page
        .getByRole("button", {
          name: `إيقاف سعر EUR رقم ${rate.id}`,
          exact: true,
        })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "تأكيد إيقاف السعر", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      const stoppedRate = (
        await call<{ exchangeRate: ExchangeRate }>(
          actor,
          `${path}/exchange-rates/${rate.id}`,
        )
      ).exchangeRate;
      assert.equal(stoppedRate.active, false);
      assert.equal(stoppedRate.rate, rate.rate);
      assert.equal(
        (
          await call<{ rate: string | null }>(
            actor,
            `${path}/exchange-rates/effective?currencyId=${currency.id}&at=2026-10-02T00:00:00.000Z`,
          )
        ).rate,
        null,
      );

      await page.goto(`${path}/branches`);
      await page
        .getByRole("button", { name: "إضافة فرع", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("كود الفرع", { exact: true }).fill("main");
      await dialog
        .getByLabel("اسم الفرع", { exact: true })
        .fill("  Browser Branch  ");
      await dialog
        .getByLabel("هاتف الفرع", { exact: true })
        .fill("+١ (٥٥٥) ٤٠٠-١٢٣٤");
      await dialog
        .getByLabel("عنوان الفرع", { exact: true })
        .fill("  Browser address  ");
      await dialog
        .getByRole("button", { name: "إضافة الفرع", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const branch = (await call<ApiPage<Branch>>(actor, `${path}/branches`))
        .items[0]!;
      assert.equal(branch.code, "MAIN");
      assert.equal(branch.phone, "+15554001234");
      assert.equal(branch.address, "Browser address");
      let locations = (
        await call<ApiPage<Location>>(
          actor,
          `${path}/locations?branchId=${branch.id}`,
        )
      ).items;
      assert.equal(locations.length, 1);
      assert.equal(locations[0]!.kind, "showroom");
      assert.equal(locations[0]!.code, "SHOWROOM");
      await page
        .getByRole("button", {
          name: "تعديل الفرع Browser Branch",
          exact: true,
        })
        .click();
      dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("اسم الفرع", { exact: true })
        .fill("Edited Browser Branch");
      await dialog
        .getByRole("button", { name: "حفظ الفرع", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await page.goto(`${path}/locations`);
      await page
        .getByRole("button", { name: "تعديل الموقع المعرض", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("اسم الموقع", { exact: true })
        .fill("Browser Showroom");
      await dialog
        .getByRole("button", { name: "حفظ الموقع", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await page
        .getByRole("button", { name: "إضافة موقع", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await searchLookup(
        page,
        dialog,
        "الفرع",
        `${path}/branches`,
        "Edited Browser Branch",
        branch.id,
      );
      await dialog.getByLabel("كود الموقع", { exact: true }).fill("wh-1");
      await dialog
        .getByLabel("اسم الموقع", { exact: true })
        .fill("Browser Warehouse");
      await dialog
        .getByRole("button", { name: "إضافة الموقع", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await page
        .getByRole("button", {
          name: "تعديل الموقع Browser Warehouse",
          exact: true,
        })
        .click();
      dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("اسم الموقع", { exact: true })
        .fill("Edited Browser Warehouse");
      await dialog
        .getByRole("button", { name: "حفظ الموقع", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await page.goto(`${path}/branches`);
      await page
        .getByRole("button", {
          name: "تعديل الفرع Edited Browser Branch",
          exact: true,
        })
        .click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("فرع فعال", { exact: true }).uncheck();
      await dialog
        .getByRole("button", { name: "حفظ الفرع", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      locations = (
        await call<ApiPage<Location>>(
          actor,
          `${path}/locations?branchId=${branch.id}`,
        )
      ).items;
      assert.equal(locations.length, 2);
      assert(
        locations.every(
          (location) =>
            location.active &&
            !location.branchActive &&
            !location.effectiveActive,
        ),
      );
      assert.equal(
        locations.find((location) => location.kind === "showroom")?.name,
        "Browser Showroom",
      );
      assert.equal(
        locations.find((location) => location.kind === "warehouse")?.name,
        "Edited Browser Warehouse",
      );
      await page.goto(`${path}/locations`);
      await eventually(
        () => page.locator("tbody").textContent(),
        (text) => assert(text?.includes("متوقف بسبب إيقاف الفرع")),
      );
      const events = (
        await call<ApiPage<AuditEvent>>(
          actor,
          `${path}/audit?pageSize=100&sort=id:desc`,
        )
      ).items;
      for (const action of [
        "account.create",
        "account.update",
        "accountLink.update",
        "currencies.initialize",
        "currency.create",
        "currency.update",
        "exchangeRate.create",
        "exchangeRate.update",
        "branch.create",
        "branch.update",
        "location.create",
        "location.update",
      ])
        assert(
          events.some((event) => event.action === action),
          `Real browser mutation must audit ${action}`,
        );
      assert.equal(
        events.find((event) => event.action === "exchangeRate.create")?.after
          ?.rate,
        "530.25",
      );
      // Existing grants are unchanged: an employee from stage 1 cannot directly enter a new module.
      const restricted = await pageFor(users[2]!.email);
      await restricted.page.goto(`/companies/${companyA.id}/accounts`);
      await restricted.page
        .getByText("ليس لديك صلاحية عرض دليل الحسابات.", { exact: true })
        .waitFor();
      assert.equal(
        await restricted.page
          .getByRole("button", { name: "إضافة حساب", exact: true })
          .count(),
        0,
      );
    },
  );

  await scenario(
    "server selectors find records beyond 100 groups, posting accounts, currencies and branches",
    async () => {
      assert(app);
      const { page, actor } = await pageFor();
      assert(actor.session.user);
      const company = (
        await call<{ company: Company }>(actor, "/companies", "POST", {
          name: "Large Selector Company",
          phone: "",
          address: "",
        })
      ).company;
      const path = `/companies/${company.id}`;
      const fixture = [company.id, actor.session.user.id];
      await app.pool.query(
        `INSERT INTO accounts(company_id,code,name,kind,category,normal_side,created_by)
         SELECT $1,(1000000000+i)::text,'Selector Group ' || lpad(i::text,3,'0'),'group','asset','debit',$2 FROM generate_series(0,120) AS i`,
        fixture,
      );
      await app.pool.query(
        `INSERT INTO accounts(company_id,code,name,kind,category,normal_side,created_by)
         SELECT $1,(2000000000+i)::text,'Selector Revenue ' || lpad(i::text,3,'0'),'posting','income','credit',$2 FROM generate_series(0,120) AS i`,
        fixture,
      );
      await call(actor, `${path}/currencies/initialize`, "POST", {
        baseCurrency: "YER",
      });
      await app.pool.query(
        `INSERT INTO company_currencies(company_id,code,name,decimal_places,created_by)
         SELECT $1,'X' || chr(65+i/26) || chr(65+i%26),'Selector Currency ' || lpad(i::text,3,'0'),2,$2 FROM generate_series(0,120) AS i`,
        fixture,
      );
      await app.pool.query(
        `WITH inserted AS (
           INSERT INTO branches(company_id,code,name,created_by)
           SELECT $1,'B' || lpad(i::text,3,'0'),'Selector Branch ' || lpad(i::text,3,'0'),$2 FROM generate_series(0,120) AS i
           RETURNING company_id,id,created_by
         ) INSERT INTO locations(company_id,branch_id,code,name,kind,created_by)
           SELECT company_id,id,'SHOWROOM','المعرض','showroom',created_by FROM inserted`,
        fixture,
      );
      const group = (
        await call<ApiPage<Account>>(
          actor,
          `${path}/accounts?kind=group&q=Selector%20Group%20120`,
        )
      ).items[0]!;
      const revenue = (
        await call<ApiPage<Account>>(
          actor,
          `${path}/accounts?kind=posting&q=Selector%20Revenue%20120`,
        )
      ).items[0]!;
      const currency = (
        await call<ApiPage<CompanyCurrency>>(
          actor,
          `${path}/currencies?q=Selector%20Currency%20120`,
        )
      ).items[0]!;
      const branch = (
        await call<ApiPage<Branch>>(
          actor,
          `${path}/branches?q=Selector%20Branch%20120`,
        )
      ).items[0]!;
      for (const [resource, id] of [
        ["accounts?kind=group", group.id],
        ["accounts?kind=posting", revenue.id],
        ["currencies?active=true", currency.id],
        ["branches?active=true", branch.id],
      ] as const) {
        const first = await call<ApiPage<{ id: number }>>(
          actor,
          `${path}/${resource}&pageSize=100&sort=code:asc`,
        );
        assert(first.total > 100);
        assert.equal(first.items.length, 100);
        assert(
          !first.items.some((item) => item.id === id),
          `${resource} target must lie beyond the first 100`,
        );
      }
      await page.goto(`${path}/accounts`);
      await page
        .getByRole("button", { name: "إضافة حساب", exact: true })
        .click();
      let dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("اسم الحساب", { exact: true })
        .fill("Created With Remote Parent");
      await dialog.getByLabel("كود الحساب", { exact: true }).fill("3000000000");
      await searchLookup(
        page,
        dialog,
        "المجموعة الأم",
        `${path}/accounts`,
        group.name,
        group.id,
      );
      await dialog
        .getByRole("button", { name: "حفظ الحساب", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const child = (
        await call<ApiPage<Account>>(
          actor,
          `${path}/accounts?q=Created%20With%20Remote%20Parent`,
        )
      ).items[0]!;
      assert.equal(child.parentId, group.id);
      await page
        .getByRole("button", { name: "ربط إيراد المبيعات", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await searchLookup(
        page,
        dialog,
        "حساب الربط",
        `${path}/accounts`,
        revenue.name,
        revenue.id,
      );
      await dialog
        .getByRole("button", { name: "حفظ الربط", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        (
          await call<{ items: AccountLink[] }>(actor, `${path}/account-links`)
        ).items.find((link) => link.purpose === "salesRevenue")?.accountId,
        revenue.id,
      );
      await page.goto(`${path}/exchange-rates`);
      await page
        .getByRole("button", { name: "إضافة سعر صرف", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await searchLookup(
        page,
        dialog,
        "العملة الأجنبية",
        `${path}/currencies`,
        currency.name,
        currency.id,
      );
      await dialog
        .getByLabel("سعر الصرف", { exact: true })
        .fill("123.456789012345");
      await dialog
        .getByLabel("وقت سريان السعر", { exact: true })
        .fill("2026-10-02T09:00");
      assert.equal(
        await dialog
          .getByLabel("وقت سريان السعر", { exact: true })
          .inputValue(),
        "2026-10-02T09:00",
      );
      await dialog
        .getByLabel("مصدر السعر اليدوي", { exact: true })
        .fill("Remote currency browser quote");
      await dialog
        .getByRole("button", { name: "حفظ سعر الصرف", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const rate = (
        await call<ApiPage<ExchangeRate>>(actor, `${path}/exchange-rates`)
      ).items[0]!;
      assert.equal(rate.currencyId, currency.id);
      assert.equal(rate.rate, "123.456789012345");
      assert.equal(rate.effectiveAt, "2026-10-02T09:00:00.000Z");
      await page.goto(`${path}/locations`);
      await page
        .getByRole("button", { name: "إضافة موقع", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await searchLookup(
        page,
        dialog,
        "الفرع",
        `${path}/branches`,
        branch.name,
        branch.id,
      );
      await dialog.getByLabel("كود الموقع", { exact: true }).fill("REMOTE-WH");
      await dialog
        .getByLabel("اسم الموقع", { exact: true })
        .fill("Created With Remote Branch");
      await dialog
        .getByRole("button", { name: "إضافة الموقع", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const warehouse = (
        await call<ApiPage<Location>>(
          actor,
          `${path}/locations?q=Created%20With%20Remote%20Branch`,
        )
      ).items[0]!;
      assert.equal(warehouse.branchId, branch.id);
      assert.equal(warehouse.effectiveActive, true);
    },
  );

  await scenario(
    "late saves on all five master routes persist in A without changing B after SPA navigation",
    async () => {
      const { page, actor } = await pageFor();
      const companies: Company[] = [];
      for (const name of ["Master Race A", "Master Race B"])
        companies.push(
          (
            await call<{ company: Company }>(actor, "/companies", "POST", {
              name,
              phone: "",
              address: "",
            })
          ).company,
        );
      const a = `/companies/${companies[0]!.id}`;
      const b = `/companies/${companies[1]!.id}`;
      await call(actor, `${a}/currencies/initialize`, "POST", {
        baseCurrency: "YER",
      });
      type MasterRecord = {
        id: number;
        companyId: number;
        name?: string;
        source?: string;
      };
      let currencyId = 0;
      let branchId = 0;
      const cases: {
        route: string;
        title: string;
        add: string;
        save: string;
        result: string;
        fill: (dialog: Locator) => Promise<void>;
      }[] = [
        {
          route: "accounts",
          title: "دليل الحسابات",
          add: "إضافة حساب",
          save: "حفظ الحساب",
          result: "account",
          fill: async (dialog) => {
            await dialog
              .getByLabel("اسم الحساب", { exact: true })
              .fill("  Race Account A  ");
            await dialog
              .getByLabel("كود الحساب", { exact: true })
              .fill("7000000000");
          },
        },
        {
          route: "currencies",
          title: "العملات",
          add: "إضافة عملة",
          save: "إضافة العملة",
          result: "currency",
          fill: async (dialog) => {
            await dialog.getByLabel("كود العملة", { exact: true }).fill("EUR");
            await dialog
              .getByLabel("اسم العملة", { exact: true })
              .fill("  Race Currency A  ");
          },
        },
        {
          route: "exchange-rates",
          title: "أسعار الصرف",
          add: "إضافة سعر صرف",
          save: "حفظ سعر الصرف",
          result: "exchangeRate",
          fill: async (dialog) => {
            await searchLookup(
              page,
              dialog,
              "العملة الأجنبية",
              `${a}/currencies`,
              "EUR",
              currencyId,
            );
            await dialog
              .getByLabel("سعر الصرف", { exact: true })
              .fill("42.125");
            await dialog
              .getByLabel("وقت سريان السعر", { exact: true })
              .fill("2026-10-03T10:00");
            assert.equal(
              await dialog
                .getByLabel("وقت سريان السعر", { exact: true })
                .inputValue(),
              "2026-10-03T10:00",
            );
            await dialog
              .getByLabel("مصدر السعر اليدوي", { exact: true })
              .fill("  Race Rate A  ");
          },
        },
        {
          route: "branches",
          title: "الفروع",
          add: "إضافة فرع",
          save: "إضافة الفرع",
          result: "branch",
          fill: async (dialog) => {
            await dialog.getByLabel("كود الفرع", { exact: true }).fill("RACE");
            await dialog
              .getByLabel("اسم الفرع", { exact: true })
              .fill("  Race Branch A  ");
          },
        },
        {
          route: "locations",
          title: "المعارض والمخازن",
          add: "إضافة موقع",
          save: "إضافة الموقع",
          result: "location",
          fill: async (dialog) => {
            await searchLookup(
              page,
              dialog,
              "الفرع",
              `${a}/branches`,
              "Race Branch A",
              branchId,
            );
            await dialog
              .getByLabel("كود الموقع", { exact: true })
              .fill("RACE-WH");
            await dialog
              .getByLabel("اسم الموقع", { exact: true })
              .fill("  Race Warehouse A  ");
          },
        },
      ];
      for (const test of cases) {
        const beforeB = await call<ApiPage<MasterRecord>>(
          actor,
          `${b}/${test.route}`,
        );
        await page.goto(`${a}/${test.route}`);
        await page.getByRole("button", { name: test.add, exact: true }).click();
        const dialog = page.getByRole("dialog");
        await test.fill(dialog);
        const held = gate();
        let arrived = false;
        let completed = false;
        let saved: MasterRecord | undefined;
        const routePattern = `**/api${a}/${test.route}`;
        await page.route(routePattern, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          if (test.route === "exchange-rates")
            assert.equal(
              (route.request().postDataJSON() as { effectiveAt: string })
                .effectiveAt,
              "2026-10-03T10:00:00.000Z",
            );
          const response = await route.fetch();
          assert(response.ok());
          saved = ((await response.json()) as Record<string, MasterRecord>)[
            test.result
          ];
          arrived = true;
          await held.promise;
          try {
            await route.fulfill({ response });
          } catch {
            /* Navigating scopes may abort the client request. */
          }
          completed = true;
        });
        try {
          await dialog
            .getByRole("button", { name: test.save, exact: true })
            .click();
          await eventually(
            async () => arrived,
            (value) => assert(value),
          );
          assert(
            await dialog
              .getByLabel(
                test.route === "exchange-rates"
                  ? "سعر الصرف"
                  : test.route === "accounts"
                    ? "اسم الحساب"
                    : test.route === "currencies"
                      ? "اسم العملة"
                      : test.route === "branches"
                        ? "اسم الفرع"
                        : "اسم الموقع",
                { exact: true },
              )
              .isDisabled(),
          );
          // A busy dialog intentionally blocks pointer navigation. Use a real SPA history transition.
          await page.evaluate((destination) => {
            window.history.pushState(
              {
                ...window.history.state,
                idx: (window.history.state?.idx ?? 0) + 1,
              },
              "",
              destination,
            );
            window.dispatchEvent(new PopStateEvent("popstate"));
          }, `${b}/${test.route}`);
          await page
            .getByRole("heading", { name: test.title, exact: true })
            .waitFor();
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          held.release();
          await eventually(
            async () => completed,
            (value) => assert(value),
          );
          assert.equal(new URL(page.url()).pathname, `${b}/${test.route}`);
          assert.equal(
            await page.locator(".scope-title strong").textContent(),
            companies[1]!.name,
          );
          assert.equal(
            await page
              .getByText(/Race (Account|Currency|Rate|Branch|Warehouse) A/)
              .count(),
            0,
            `${test.route} must not insert A data or notices into B`,
          );
          assert.deepEqual(
            await call<ApiPage<MasterRecord>>(actor, `${b}/${test.route}`),
            beforeB,
            `${test.route} must leave B unchanged`,
          );
          assert(saved);
          assert.equal(saved.companyId, companies[0]!.id);
          const stored = (
            await call<Record<string, MasterRecord>>(
              actor,
              `${a}/${test.route}/${saved.id}`,
            )
          )[test.result]!;
          assert.equal(stored.id, saved.id);
          assert.equal(
            stored.name ?? stored.source,
            (saved.name ?? saved.source)?.trim(),
          );
          if (test.route === "currencies") currencyId = stored.id;
          if (test.route === "branches") branchId = stored.id;
        } finally {
          held.release();
          await page.unroute(routePattern);
        }
      }
      assert.equal(
        (await call<ApiPage<Location>>(actor, `${b}/locations`)).total,
        0,
      );
    },
  );

  await scenario(
    "all five master routes retain light and dark compact desktop/mobile geometry and keyboard navigation",
    async () => {
      const company = (
        await call<{ company: Company }>(owner, "/companies", "POST", {
          name: "Master Density Company",
          phone: "",
          address: "",
        })
      ).company;
      const path = `/companies/${company.id}`;
      await call(owner, `${path}/accounts/initialize`, "POST", {});
      await call(owner, `${path}/currencies/initialize`, "POST", {
        baseCurrency: "YER",
      });
      const usd = (
        await call<ApiPage<CompanyCurrency>>(owner, `${path}/currencies?q=USD`)
      ).items[0]!;
      await call(owner, `${path}/exchange-rates`, "POST", {
        currencyId: usd.id,
        rate: "530.25",
        effectiveAt: "2026-10-01T00:00:00.000Z",
        source: "Density fixture quote",
      });
      const branch = (
        await call<{ branch: Branch }>(owner, `${path}/branches`, "POST", {
          code: "DENSITY",
          name: "Density Branch",
          phone: "",
          address: "",
        })
      ).branch;
      await call(owner, `${path}/locations`, "POST", {
        branchId: branch.id,
        code: "WH",
        name: "Density Warehouse",
        kind: "warehouse",
      });
      for (const mobile of [false, true]) {
        const { page, actor } = await pageFor("owner@browser.test", mobile);
        if (!mobile) await page.setViewportSize({ width: 1440, height: 768 });
        for (const mode of ["light", "dark"] as const) {
          await call(actor, "/appearance", "PATCH", {
            scope: `company:${company.id}`,
            mode,
            color: "#176b61",
          });
          for (const [route, title] of [
            ["accounts", "دليل الحسابات"],
            ["currencies", "العملات"],
            ["exchange-rates", "أسعار الصرف"],
            ["branches", "الفروع"],
            ["locations", "المعارض والمخازن"],
          ] as const) {
            await page.goto(`${path}/${route}`);
            await page
              .getByRole("heading", { name: title, exact: true })
              .waitFor();
            await eventually(
              () => rowIds(page),
              (ids) => assert(ids.length > 0),
            );
            await eventually(
              () => page.locator("html").getAttribute("data-theme"),
              (theme) => assert.equal(theme, mode),
            );
            assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
            const geometry = await page.evaluate(() => ({
              controls: [
                ...document.querySelectorAll<HTMLElement>(
                  '.main-content input:not([type="checkbox"]), .main-content select',
                ),
              ]
                .filter((element) => element.getBoundingClientRect().height > 0)
                .map((element) => ({
                  height: element.getBoundingClientRect().height,
                  font: getComputedStyle(element).fontSize,
                })),
              rows: [
                ...document.querySelectorAll<HTMLElement>(
                  "tbody tr[data-row-id]",
                ),
              ].map((row) => ({
                height: row.getBoundingClientRect().height,
                font: getComputedStyle(row).fontSize,
              })),
              sticky: getComputedStyle(document.querySelector("th")!).position,
            }));
            assert(
              geometry.controls.length >= 2,
              `${route} must render its compact server filter controls`,
            );
            for (const control of geometry.controls) {
              assert.equal(control.font, "14px", `${mode} ${route} field font`);
              assert.equal(
                control.height,
                mobile ? 38 : 32,
                `${mode} ${route} field height`,
              );
            }
            assert(geometry.rows.length > 0);
            for (const row of geometry.rows) {
              assert.equal(row.font, "14px", `${mode} ${route} row font`);
              assert(
                Math.abs(row.height - (mobile ? 38 : 34)) < 0.5,
                `${mode} ${route} row height ${row.height}`,
              );
            }
            assert.equal(geometry.sticky, "sticky");
            if (!mobile) {
              const navigation = page.locator(".sidebar nav");
              const first = navigation.locator("a").first();
              const last = navigation.locator("a").last();
              assert.equal(await last.getAttribute("href"), `${path}/audit`);
              await first.focus();
              const linkCount = await navigation.locator("a").count();
              for (let index = 1; index < linkCount; index++)
                await page.keyboard.press("Tab");
              assert(
                await last.evaluate(
                  (element) => element === document.activeElement,
                ),
                "Last company sidebar link must be reachable by Tab",
              );
              const bounds = await last.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const parent = element.closest("nav")!.getBoundingClientRect();
                return {
                  top: rect.top,
                  bottom: rect.bottom,
                  visibleTop: parent.top,
                  visibleBottom: parent.bottom,
                  viewport: innerHeight,
                };
              });
              assert(
                bounds.top >= bounds.visibleTop &&
                  bounds.bottom <= bounds.visibleBottom + 1 &&
                  bounds.bottom <= bounds.viewport,
                `Focused sidebar link must scroll into the 768px viewport: ${JSON.stringify(bounds)}`,
              );
              assert.equal(
                new URL(page.url()).pathname,
                `${path}/${route}`,
                "Keyboard focus must preserve the current master route",
              );
            }
          }
        }
      }
    },
  );

  assert.equal(
    pageErrors.length,
    0,
    `Unexpected browser exceptions: ${pageErrors.join("; ")}`,
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
console.log(`Browser scenarios: ${passed} passed, ${failures.length} failed`);
assert(passed > 0, "No browser scenarios executed");
assert.equal(
  failures.length,
  0,
  `Failed browser scenarios: ${failures.join(", ")}`,
);
