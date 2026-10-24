import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import {
  chromium,
  request,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { SessionResponse } from "../packages/contracts/src/index.ts";

// Only synthetic identities and records in a disposable local test schema.
const schema = "browser_legal_tasks_" + randomUUID().replaceAll("-", "");
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
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
let browser: Browser | undefined;
const contexts: BrowserContext[] = [];
const errors: string[] = [];
async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await api.fetch("/api" + path, {
    method,
    headers: {
      origin,
      ...(session.csrf ? { "x-csrf-token": session.csrf } : {}),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  const data = await response.json();
  assert(
    response.ok(),
    `${method} ${path}: ${response.status()} ${JSON.stringify(data)}`,
  );
  return data as T;
}
async function pageFor(mobile = false): Promise<Page> {
  assert(browser);
  const context = await browser.newContext({
    baseURL: origin,
    storageState: await api.storageState(),
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 960 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  contexts.push(context);
  context.setDefaultTimeout(12_000);
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
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Expected legal task browser state did not arrive");
}
async function contained(page: Page, expectedWidth: number) {
  const size = await page.evaluate(() => ({
    width: innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    scroll: document
      .querySelector(".legal-task-scroll")
      ?.getBoundingClientRect().width,
    direction: getComputedStyle(document.documentElement).direction,
  }));
  assert.equal(size.width, expectedWidth);
  assert.equal(size.direction, "rtl");
  assert(
    size.html <= expectedWidth + 1 && size.body <= expectedWidth + 1,
    JSON.stringify(size),
  );
  assert(
    size.scroll !== undefined && size.scroll <= expectedWidth,
    JSON.stringify(size),
  );
}
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  await mkdir("work", { recursive: true });
  const password = "Legal-task-browser-passphrase-2026";
  const owner = await provisionOwner(runtime.pool, {
    name: "Task owner",
    displayName: "Task owner",
    email: "owner@legal-tasks.browser.test",
    password,
  });
  session = await call<SessionResponse>("/auth/login", "POST", {
    email: owner.email,
    password,
  });
  const legalCase = (
    await call<{ record: { id: number } }>("/legal/cases", "POST", {
      title: "قضية ترتيب المهام الاختبارية",
    })
  ).record;
  const urgentTitle = "متابعة عاجلة بموعد سابق";
  const routineTitle = "متابعة إدارية دورية";
  const urgent = (
    await call<{ record: { id: number } }>("/legal/records", "POST", {
      kind: "task",
      title: urgentTitle,
      body: "موعد متابعة مسجل يستلزم التحقق",
      status: "pending",
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      sortOrder: 999,
      caseIds: [legalCase.id],
    })
  ).record;
  const routine = (
    await call<{ record: { id: number } }>("/legal/records", "POST", {
      kind: "task",
      title: routineTitle,
      body: "مهمة عادية دون موعد",
      status: "pending",
      sortOrder: 0,
      caseIds: [legalCase.id],
    })
  ).record;
  const urgentBefore = await call<{ record: unknown }>(
    `/legal/records/${urgent.id}`,
  );
  const page = await pageFor();
  await page.goto(`/legal-cases?case=${legalCase.id}&tab=task`);
  const board = page.getByRole("table", { name: "المهام حسب الأولوية" });
  await board.getByText(urgentTitle, { exact: true }).waitFor();
  const firstBoardTitle = () =>
    board
      .locator("tbody tr")
      .first()
      .locator("td")
      .nth(2)
      .locator("strong")
      .textContent();
  const firstCaseTitle = () =>
    page.locator(".legal-entry h3").first().textContent();
  await eventually(
    async () =>
      (await firstBoardTitle()) === urgentTitle &&
      (await firstCaseTitle()) === urgentTitle,
  );
  await contained(page, 1440);
  await page.screenshot({
    path: "work/legal-tasks-desktop.png",
    fullPage: true,
  });
  console.log(
    "PASS automatic urgency wins over legacy sort order in global and case task lists",
  );

  const routineRow = board
    .locator("tbody tr")
    .filter({ hasText: routineTitle });
  await routineRow
    .getByRole("button", { name: "تغيير الأولوية", exact: true })
    .click();
  assert.equal(
    await routineRow.getByLabel("الأولوية", { exact: true }).inputValue(),
    "auto",
    "Opening an automatic task must preserve automatic mode",
  );
  await routineRow.getByLabel("الأولوية", { exact: true }).selectOption("1");
  await routineRow
    .getByLabel("سبب الأولوية", { exact: true })
    .fill("ترتيب مستقل لهذه المهمة فقط");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/legal/tasks/${routine.id}/priority`) &&
        response.request().method() === "PUT" &&
        response.ok(),
    ),
    routineRow
      .getByRole("button", { name: "حفظ الأولوية", exact: true })
      .click(),
  ]);
  await eventually(
    async () =>
      (await firstBoardTitle()) === routineTitle &&
      (await firstCaseTitle()) === routineTitle,
  );
  assert.deepEqual(
    (await call<{ record: unknown }>(`/legal/records/${urgent.id}`)).record,
    urgentBefore.record,
    "A single-task priority change must not modify any other task",
  );
  await page.reload();
  await board.getByText(routineTitle, { exact: true }).waitFor();
  await eventually(
    async () =>
      (await firstBoardTitle()) === routineTitle &&
      (await firstCaseTitle()) === routineTitle,
  );
  const persisted = (
    await call<{
      record: { task_priority: number; task_priority_reason: string };
    }>(`/legal/records/${routine.id}`)
  ).record;
  assert.equal(persisted.task_priority, 1);
  assert.equal(persisted.task_priority_reason, "ترتيب مستقل لهذه المهمة فقط");
  console.log(
    "PASS single-task manual priority persists after reload and leaves other task data unchanged",
  );

  const routineArticle = page.locator(".legal-entry").filter({
    has: page.getByRole("heading", { name: routineTitle, exact: true }),
  });
  await routineArticle
    .getByRole("button", { name: "تغيير الأولوية", exact: true })
    .click();
  assert.equal(
    await routineArticle.getByLabel("الأولوية", { exact: true }).inputValue(),
    "1",
  );
  await routineArticle
    .getByLabel("الأولوية", { exact: true })
    .selectOption("auto");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/legal/tasks/${routine.id}/priority`) &&
        response.request().method() === "PUT" &&
        response.ok(),
    ),
    routineArticle
      .getByRole("button", { name: "حفظ الأولوية", exact: true })
      .click(),
  ]);
  await eventually(
    async () =>
      (await firstBoardTitle()) === urgentTitle &&
      (await firstCaseTitle()) === urgentTitle,
  );
  const automatic = (
    await call<{
      record: { task_priority: number | null; task_priority_reason: string };
    }>(`/legal/records/${routine.id}`)
  ).record;
  assert.equal(automatic.task_priority, null);
  assert.equal(automatic.task_priority_reason, "");
  await routineRow
    .getByRole("button", { name: "تغيير الأولوية", exact: true })
    .click();
  assert.equal(
    await routineRow.getByLabel("الأولوية", { exact: true }).inputValue(),
    "auto",
  );
  await routineRow.getByRole("button", { name: "إلغاء", exact: true }).click();
  console.log(
    "PASS automatic reset from the case task controls refreshes both views and reopens in automatic mode",
  );

  const secondCaseTitle = "قضية ثانية لاختبار عزل المسودات";
  const secondCase = (
    await call<{ record: { id: number } }>("/legal/cases", "POST", {
      title: secondCaseTitle,
    })
  ).record;
  await call("/legal/records", "POST", {
    kind: "task",
    title: "مهمة القضية الثانية",
    status: "pending",
    caseIds: [secondCase.id],
  });
  const firstCaseBefore = await call<{ record: unknown }>(
    `/legal/cases/${legalCase.id}`,
  );
  const secondCaseBefore = await call<{ record: unknown }>(
    `/legal/cases/${secondCase.id}`,
  );
  await page.reload();
  await board.getByText("مهمة القضية الثانية", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "تعديل بيانات القضية", exact: true })
    .click();
  await page
    .getByLabel("اسم القضية", { exact: true })
    .fill("مسودة قضية لم تحفظ");
  await board
    .getByRole("button", { name: secondCaseTitle, exact: true })
    .click();
  await eventually(
    async () =>
      new URL(page.url()).searchParams.get("case") === String(secondCase.id) &&
      (await page
        .locator(".legal-content")
        .getByRole("heading", { name: secondCaseTitle, exact: true })
        .count()) === 1,
  );
  assert.equal(await page.getByLabel("اسم القضية", { exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "حفظ", exact: true }).count(),
    0,
  );
  assert.deepEqual(
    (await call<{ record: unknown }>(`/legal/cases/${secondCase.id}`)).record,
    secondCaseBefore.record,
    "Navigating to another case must not apply an unsaved metadata draft",
  );
  await page.getByRole("button", { name: "قضية جديدة", exact: true }).click();
  await page
    .getByLabel("اسم القضية", { exact: true })
    .fill("مسودة قضية جديدة لم تحفظ");
  await board
    .getByRole("button", { name: "قضية ترتيب المهام الاختبارية", exact: true })
    .first()
    .click();
  await eventually(
    async () =>
      new URL(page.url()).searchParams.get("case") === String(legalCase.id) &&
      (await page
        .locator(".legal-content")
        .getByRole("heading", {
          name: "قضية ترتيب المهام الاختبارية",
          exact: true,
        })
        .count()) === 1,
  );
  assert.equal(await page.getByLabel("اسم القضية", { exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "حفظ القضية", exact: true }).count(),
    0,
  );
  assert.equal((await call<{ total: number }>("/legal/cases")).total, 2);
  assert.deepEqual(
    (await call<{ record: unknown }>(`/legal/cases/${legalCase.id}`)).record,
    firstCaseBefore.record,
    "Leaving either metadata editor must preserve existing case data",
  );
  console.log(
    "PASS board navigation clears existing-case and new-case drafts without modifying either case",
  );

  const mobile = await pageFor(true);
  await mobile.goto(`/legal-cases?case=${legalCase.id}&tab=task`);
  const mobileBoard = mobile.getByRole("table", {
    name: "المهام حسب الأولوية",
  });
  await mobileBoard.getByText(urgentTitle, { exact: true }).waitFor();
  await contained(mobile, 390);
  const mobileRow = mobileBoard
    .locator("tbody tr")
    .filter({ hasText: routineTitle });
  await mobileRow
    .getByRole("button", { name: "تغيير الأولوية", exact: true })
    .click();
  await contained(mobile, 390);
  assert.equal(
    await mobileRow.getByLabel("الأولوية", { exact: true }).inputValue(),
    "auto",
  );
  await mobile.screenshot({
    path: "work/legal-tasks-mobile.png",
    fullPage: true,
  });
  await mobileRow.getByRole("button", { name: "إلغاء", exact: true }).click();
  console.log(
    "PASS mobile task board and inline priority editor keep page scrolling contained",
  );
  assert.deepEqual(errors, [], errors.join("; "));
} finally {
  for (const context of contexts) await context.close();
  await browser?.close();
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
console.log("Legal task browser regression passed");
