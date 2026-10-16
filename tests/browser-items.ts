import assert from "node:assert/strict";
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
  type Locator,
  type Page,
} from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Company,
  CompanyCurrency,
  Employee,
  Item,
  ItemAgent,
  Page as ApiPage,
  SessionResponse,
} from "../packages/contracts/src/index.ts";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql:///tijara?host=%2Fworkspace%2F.tools%2Fpostgresql%2Fsocket&port=55432&user=agent";
const schema = `browser_items_${process.pid}_${Date.now()}`;
const password = "Items-browser-password-2026";
const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    assert(address && typeof address === "object");
    probe.close(() => resolve(address.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
interface Actor {
  context: APIRequestContext;
  session: SessionResponse;
}
const contexts: BrowserContext[] = [];
const apiContexts: APIRequestContext[] = [];
const failures: string[] = [];
const pageErrors: string[] = [];
let browser: Browser | undefined;
let server: Server | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let passed = 0;

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
  const actor: Actor = {
    context: context ?? (await request.newContext({ baseURL: origin })),
    session: { user: null, csrf: null },
  };
  if (!context) apiContexts.push(actor.context);
  actor.session = await call<SessionResponse>(actor, "/auth/login", "POST", {
    email,
    password,
  });
  assert(actor.session.user);
  return actor;
}
async function pageFor(email = "owner@items.browser.test", mobile = false) {
  assert(browser);
  const context = await browser.newContext({
    baseURL: origin,
    timezoneId: "UTC",
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 960 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  context.setDefaultTimeout(10000);
  contexts.push(context);
  const actor = await actorFor(email, context.request);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { page, actor, context };
}
async function scenario(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`, error);
    const page = contexts.at(-1)?.pages().at(-1);
    if (page && !page.isClosed()) {
      console.error(`Failure page: ${page.url()}`);
      await page
        .screenshot({
          path: `/tmp/tijara-items-failure-${failures.length}.png`,
          fullPage: true,
        })
        .catch(() => {});
    }
  }
}
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => void,
  timeout = 10000,
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
async function selectLookup(
  page: Page,
  container: Page | Locator,
  label: string,
  query: string,
  accountId: number,
) {
  const response = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.searchParams.get("q") === query &&
      response.ok()
    );
  });
  await container.getByLabel(`بحث عن ${label}`, { exact: true }).fill(query);
  await response;
  const select = container.getByLabel(label, { exact: true });
  await select
    .locator(`option[value="${accountId}"]`)
    .waitFor({ state: "attached" });
  await select.selectOption(String(accountId));
}
async function pick(
  page: Page,
  button: Locator,
  label: string,
  query: string,
  id: number,
) {
  await button.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await selectLookup(page, dialog, label, query, id);
  await dialog.waitFor({ state: "hidden" });
}
function pickerButton(page: Page, label: string) {
  return page
    .locator(".field")
    .filter({ has: page.getByText(label, { exact: true }) })
    .getByRole("button")
    .first();
}

async function saveItem(page: Page, base: string, id?: number) {
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api${base}/items${id ? `/${id}` : ""}` &&
      response.request().method() === (id ? "PATCH" : "POST"),
  );
  await page.getByRole("button", { name: "حفظ الصنف", exact: true }).click();
  const result = await response,
    body = (await result.json()) as { item: Item };
  assert(result.ok(), `${result.status()} ${JSON.stringify(body)}`);
  await page.waitForURL(`${origin}${base}/items/${body.item.id}`);
  await page.getByLabel("اسم الصنف", { exact: true }).waitFor();
  return body.item;
}

function patchBody(item: Item, overrides: Record<string, unknown> = {}) {
  return {
    name: item.name,
    englishName: item.englishName,
    barcode: item.barcode,
    agentId: item.agentId,
    unit1Name: item.unit1Name,
    unit2Name: item.unit2Name,
    unit3Name: item.unit3Name,
    factor2: item.factor2,
    factor3: item.factor3,
    salePrice1: item.salePrice1,
    salePrice2: item.salePrice2,
    salePrice3: item.salePrice3,
    purchasePrice: item.purchasePrice,
    purchaseFactor: item.purchaseFactor,
    currencyId: item.currencyId,
    reorderLimit: item.reorderLimit,
    orderQuantity: item.orderQuantity,
    searchKeys: item.searchKeys,
    purchaseNotes: item.purchaseNotes,
    orderStoppedUntil: item.orderStoppedUntil,
    hasExpiry: item.hasExpiry,
    active: item.active,
    revision: item.revision,
    ...overrides,
  };
}

async function assertViewport(page: Page, width: number) {
  const sizes = await page.evaluate(() => ({
    width: innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    direction: getComputedStyle(document.documentElement).direction,
  }));
  assert.equal(sizes.width, width);
  assert.equal(sizes.direction, "rtl");
  assert(sizes.html <= width + 1, `HTML overflow: ${JSON.stringify(sizes)}`);
  assert(sizes.body <= width + 1, `Body overflow: ${JSON.stringify(sizes)}`);
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
    name: "Items Browser Owner",
    displayName: "Items Browser Owner",
    email: "owner@items.browser.test",
    password,
  });
  server = app.app.listen(port, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const owner = await actorFor("owner@items.browser.test");
  const companyA = (
    await call<{ company: Company }>(owner, "/companies", "POST", {
      name: "شركة اختبار الأصناف",
      phone: "",
      address: "صنعاء",
    })
  ).company;
  const companyB = (
    await call<{ company: Company }>(owner, "/companies", "POST", {
      name: "شركة معزولة",
      phone: "",
      address: "عدن",
    })
  ).company;
  const base = `/companies/${companyA.id}`;
  const currency = (
    await call<{ currency: CompanyCurrency }>(
      owner,
      `${base}/currencies`,
      "POST",
      { code: "YER", name: "ريال يمني", decimalPlaces: 2 },
    )
  ).currency;
  await app.pool.query(
    "INSERT INTO item_agents(company_id,name,created_by,idempotency_key,creation_payload) SELECT $1,'وكيل تجربة '||n,$2,gen_random_uuid(),'{}'::jsonb FROM generate_series(1,105) n",
    [companyA.id, owner.session.user!.id],
  );
  const distantAgent = (
    await call<{ agent: ItemAgent }>(owner, `${base}/item-agents`, "POST", {
      name: "وكيل خارج أول مئة",
      idempotencyKey: crypto.randomUUID(),
    })
  ).agent;
  const register: Actor = {
    context: await request.newContext({ baseURL: origin }),
    session: { user: null, csrf: null },
  };
  apiContexts.push(register.context);
  const reader = (
    await call<SessionResponse>(register, "/auth/register", "POST", {
      name: "Items reader",
      displayName: "Items reader",
      email: "reader@items.browser.test",
      phone: "",
      password,
    })
  ).user!;
  await call<{ employee: Employee }>(owner, `${base}/employees`, "POST", {
    userId: reader.id,
    name: "قارئ الأصناف",
    phone: "",
    role: "employee",
    active: true,
    permissions: ["items.view"],
  });
  const { page } = await pageFor();
  let createdAgent: ItemAgent | undefined, createdItem: Item | undefined;

  await scenario(
    "agent creation normalizes phone and successful save closes the modal",
    async () => {
      await page.goto(`${base}/item-agents`);
      await page
        .getByRole("button", { name: "وكيل جديد", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await dialog
        .getByLabel("اسم الوكيل", { exact: true })
        .fill("وكيل جديد من الواجهة");
      await dialog
        .getByLabel("هاتف الوكيل", { exact: true })
        .fill("٠٥٠ (١١١) ٢٢٢٢");
      await dialog.getByLabel("عنوان الوكيل", { exact: true }).fill("صنعاء");
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api${base}/item-agents` &&
          response.request().method() === "POST",
      );
      await dialog
        .getByRole("button", { name: "حفظ الوكيل", exact: true })
        .click();
      const actual = await response;
      assert(actual.ok());
      createdAgent = ((await actual.json()) as { agent: ItemAgent }).agent;
      assert.equal(createdAgent.phone, "0501112222");
      await dialog.waitFor({ state: "hidden" });
      await page
        .getByText(`تم حفظ الوكيل ${createdAgent.name}.`, { exact: true })
        .waitFor();
    },
  );

  await scenario(
    "item creation selects agents beyond first 100 results and retains independent unit prices",
    async () => {
      await page.goto(`${base}/items/new`);
      await page
        .getByLabel("اسم الصنف", { exact: true })
        .fill("فولتارين الواجهة");
      await page
        .getByLabel("الاسم بالإنجليزية", { exact: true })
        .fill("Voltaren UI");
      await page.getByLabel("الباركود", { exact: true }).fill("١٢٣٤٥٦٧٨");
      await pick(
        page,
        pickerButton(page, "عملة الأسعار"),
        "العملة",
        "YER",
        currency.id,
      );
      await pick(
        page,
        pickerButton(page, "وكيل الصنف"),
        "الوكيل",
        distantAgent.name,
        distantAgent.id,
      );
      await page.getByLabel("اسم الوحدة الثانية", { exact: true }).fill("شريط");
      await page.getByLabel("اسم الوحدة الثالثة", { exact: true }).fill("حبة");
      await page
        .getByLabel("عدد الثانية داخل الأولى", { exact: true })
        .fill("٢");
      await page
        .getByLabel("عدد الثالثة داخل الثانية", { exact: true })
        .fill("١٢");
      for (const [label, value] of [
        ["سعر بيع الوحدة الأولى", "1000"],
        ["سعر بيع الوحدة الثانية", "500"],
        ["سعر بيع الوحدة الثالثة", "50"],
        ["سعر الشراء الافتراضي", "800"],
      ])
        await page.getByLabel(label!, { exact: true }).fill(value!);
      await page
        .getByLabel("حد الطلب", { exact: true })
        .fill("9007199254740993");
      await page
        .getByLabel("مفاتيح البحث", { exact: true })
        .fill("فلتارين ف15");
      await page.getByLabel("الكمية للمعاينة", { exact: true }).fill("2");
      await page.getByLabel("وحدة المعاينة", { exact: true }).selectOption("3");
      await page
        .locator(".item-preview-results bdi")
        .getByText("1/12", { exact: true })
        .waitFor();
      createdItem = await saveItem(page, base);
      assert.equal(createdItem.factor2, 2);
      assert.equal(createdItem.factor3, 12);
      assert.equal(createdItem.barcode, "12345678");
      assert.equal(createdItem.salePrice1, "1000");
      assert.equal(createdItem.salePrice2, "500");
      assert.equal(createdItem.salePrice3, "50");
      assert.equal(createdItem.reorderLimit, "9007199254740993");
      assert.equal(createdItem.agentId, distantAgent.id);
    },
  );

  await scenario(
    "item revision conflict preserves local edits until an explicit confirmed reload",
    async () => {
      assert(createdItem);
      await page.goto(`${base}/items/${createdItem.id}`);
      await page
        .getByLabel("اسم الصنف", { exact: true })
        .fill("تعديل محلي غير محفوظ");
      const latest = (
        await call<{ item: Item }>(
          owner,
          `${base}/items/${createdItem.id}`,
          "PATCH",
          patchBody(createdItem, { name: "تعديل من مستخدم آخر" }),
        )
      ).item;
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api${base}/items/${createdItem!.id}` &&
          response.request().method() === "PATCH",
      );
      await page
        .getByRole("button", { name: "حفظ الصنف", exact: true })
        .click();
      assert.equal((await response).status(), 409);
      assert.equal(
        await page.getByLabel("اسم الصنف", { exact: true }).inputValue(),
        "تعديل محلي غير محفوظ",
      );
      await page
        .getByRole("button", { name: "تحميل النسخة الحالية", exact: true })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("button", { name: "تأكيد التحميل", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await eventually(
        () => page.getByLabel("اسم الصنف", { exact: true }).inputValue(),
        (value) => assert.equal(value, latest.name),
      );
      await page
        .getByLabel("سعر بيع الوحدة الثالثة", { exact: true })
        .fill("51.25");
      createdItem = await saveItem(page, base, latest.id);
      assert.equal(createdItem.salePrice1, "1000");
      assert.equal(createdItem.salePrice2, "500");
      assert.equal(createdItem.salePrice3, "51.25");
      await call(owner, `${base}/item-agents/${distantAgent.id}`, "PATCH", {
        name: distantAgent.name,
        phone: distantAgent.phone,
        address: distantAgent.address,
        notes: distantAgent.notes,
        active: false,
        revision: distantAgent.revision,
      });
      await page.goto(`${base}/items/${createdItem.id}`);
      await page.getByText("الوكيل مؤرشف", { exact: true }).waitFor();
      await page
        .getByLabel("ملاحظات الشراء", { exact: true })
        .fill("حفظ ملاحظة مع مرجع مؤرشف");
      createdItem = await saveItem(page, base, createdItem.id);
      assert.equal(createdItem.agentId, distantAgent.id);
      assert.equal(createdItem.agentActive, false);
    },
  );

  await scenario(
    "lost creation acknowledgement freezes fields and retries identical body without duplicate item",
    async () => {
      await page.goto(`${base}/items/new`);
      await page
        .getByLabel("اسم الصنف", { exact: true })
        .fill("صنف إعادة التأكيد");
      await pick(
        page,
        pickerButton(page, "عملة الأسعار"),
        "العملة",
        "YER",
        currency.id,
      );
      const before = await call<ApiPage<Item>>(owner, `${base}/items`);
      let original: unknown, committed: Item | undefined;
      await page.route(
        `**/api${base}/items`,
        async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          original = route.request().postDataJSON();
          const response = await route.fetch();
          assert(response.ok());
          committed = ((await response.json()) as { item: Item }).item;
          await route.abort("failed");
        },
        { times: 1 },
      );
      await page
        .getByRole("button", { name: "حفظ الصنف", exact: true })
        .click();
      await page
        .getByRole("button", { name: "إعادة تأكيد الحفظ", exact: true })
        .waitFor();
      assert(committed);
      for (const label of [
        "اسم الصنف",
        "سعر بيع الوحدة الأولى",
        "عدد الثانية داخل الأولى",
        "حد الطلب",
      ])
        assert(await page.getByLabel(label, { exact: true }).isDisabled());
      assert(await pickerButton(page, "عملة الأسعار").isDisabled());
      const retry = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname === `/api${base}/items` &&
          request.method() === "POST",
      );
      await page
        .getByRole("button", { name: "إعادة تأكيد الحفظ", exact: true })
        .click();
      assert.deepEqual((await retry).postDataJSON(), original);
      await page.waitForURL(`${origin}${base}/items/${committed.id}`);
      const after = await call<ApiPage<Item>>(owner, `${base}/items`);
      assert.equal(after.total, before.total + 1);
    },
  );

  await scenario(
    "dirty item navigation requires an explicit stay or discard choice",
    async () => {
      assert(createdItem);
      await page.goto(`${base}/items/${createdItem.id}`);
      await page
        .getByLabel("ملاحظات الشراء", { exact: true })
        .fill("تعديل يجب ألا يضيع");
      await page.locator(`.sidebar a[href="${base}/item-agents"]`).click();
      let dialog = page.getByRole("dialog");
      await dialog
        .getByRole("button", { name: "البقاء في الكرت", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await page.getByLabel("ملاحظات الشراء", { exact: true }).inputValue(),
        "تعديل يجب ألا يضيع",
      );
      await page.locator(`.sidebar a[href="${base}/items"]`).click();
      dialog = page.getByRole("dialog");
      await dialog
        .getByRole("button", { name: "مغادرة دون حفظ", exact: true })
        .click();
      await page.waitForURL(`${origin}${base}/items`);
      await page
        .getByRole("button", {
          name: `تعديل الصنف ${createdItem.code}`,
          exact: true,
        })
        .click();
      await page
        .getByLabel("ملاحظات الشراء", { exact: true })
        .fill("تعديل محفوظ أثناء الرجوع");
      await page.evaluate(() => window.history.back());
      dialog = page.getByRole("dialog");
      await dialog
        .getByRole("button", { name: "البقاء في الكرت", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await page.getByLabel("ملاحظات الشراء", { exact: true }).inputValue(),
        "تعديل محفوظ أثناء الرجوع",
      );
      await page
        .getByRole("button", { name: "العودة للقائمة", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "مغادرة دون حفظ", exact: true })
        .click();
      await page.waitForURL(`${origin}${base}/items`);
    },
  );

  await scenario(
    "view-only employees can inspect items and preview conversion without seeing management controls",
    async () => {
      assert(createdItem);
      const readOnly = await pageFor(reader.email);
      await readOnly.page.goto(`${base}/items`);
      await readOnly.page
        .getByRole("heading", { name: "الأصناف", exact: true })
        .waitFor();
      assert.equal(
        await readOnly.page
          .getByRole("button", { name: "صنف جديد", exact: true })
          .count(),
        0,
      );
      await readOnly.page
        .getByRole("button", {
          name: `عرض الصنف ${createdItem.code}`,
          exact: true,
        })
        .click();
      assert(
        await readOnly.page
          .getByLabel("اسم الصنف", { exact: true })
          .isDisabled(),
      );
      assert.equal(
        await readOnly.page
          .getByRole("button", { name: "حفظ الصنف", exact: true })
          .count(),
        0,
      );
      await readOnly.page
        .getByLabel("الكمية للمعاينة", { exact: true })
        .fill("2");
      await readOnly.page
        .getByLabel("وحدة المعاينة", { exact: true })
        .selectOption("3");
      await readOnly.page
        .locator(".item-preview-results bdi")
        .getByText("1/12", { exact: true })
        .waitFor();
      await readOnly.page.goto(`${base}/item-agents`);
      await readOnly.page
        .getByRole("heading", { name: "وكلاء الأصناف", exact: true })
        .waitFor();
      assert.equal(
        await readOnly.page
          .getByRole("button", { name: "وكيل جديد", exact: true })
          .count(),
        0,
      );
    },
  );

  await scenario(
    "desktop and mobile item screens preserve RTL, dark mode and compact readable inputs",
    async () => {
      assert(createdItem);
      await call(owner, "/appearance", "PATCH", {
        scope: `company:${companyA.id}`,
        mode: "dark",
        color: "#7c3aed",
      });
      await page.goto(`${base}/items/${createdItem.id}`);
      await page.getByLabel("اسم الصنف", { exact: true }).waitFor();
      await assertViewport(page, 1440);
      const desktop = await page
        .getByLabel("اسم الصنف", { exact: true })
        .evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          font: getComputedStyle(element).fontSize,
        }));
      assert.equal(desktop.height, 32);
      assert.equal(desktop.font, "14px");
      const itemLabelInside = await page.getByLabel("اسم الصنف", { exact: true })
        .evaluate((input) => {
          const label = input.closest(".field")?.querySelector("label");
          const box = input.getBoundingClientRect();
          const title = label?.getBoundingClientRect();
          return !!title && title.top >= box.top && title.bottom <= box.bottom;
        });
      assert(itemLabelInside, "Item name label must be inside its compact input");
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "dark",
      );
      await page.screenshot({
        path: "/tmp/tijara-items-desktop-dark.png",
        fullPage: true,
      });
      const mobile = await pageFor("owner@items.browser.test", true);
      for (const path of [
        "items",
        `items/${createdItem.id}`,
        "items/new",
        "item-agents",
      ]) {
        await mobile.page.goto(`${base}/${path}`);
        if (path.includes("/")) {
          await mobile.page.getByLabel("اسم الصنف", { exact: true }).waitFor();
          const field = await mobile.page
            .getByLabel("اسم الصنف", { exact: true })
            .evaluate((element) => ({
              height: element.getBoundingClientRect().height,
              font: getComputedStyle(element).fontSize,
            }));
          assert.equal(field.height, 38);
          assert.equal(field.font, "14px");
        } else
          await mobile.page
            .getByRole("heading", {
              name: path === "items" ? "الأصناف" : "وكلاء الأصناف",
              exact: true,
            })
            .waitFor();
        await assertViewport(mobile.page, 390);
      }
      await mobile.page.goto(`${base}/items/${createdItem.id}`);
      await mobile.page.getByLabel("اسم الصنف", { exact: true }).waitFor();
      await mobile.page.screenshot({
        path: "/tmp/tijara-items-mobile.png",
        fullPage: true,
      });
    },
  );

  await scenario(
    "late item-list response cannot leak data after navigating to another company",
    async () => {
      let started!: () => void, release!: () => void;
      const incoming = new Promise<void>((resolve) => {
          started = resolve;
        }),
        released = new Promise<void>((resolve) => {
          release = resolve;
        });
      await page.goto(`${base}/item-agents`);
      await page
        .getByRole("heading", { name: "وكلاء الأصناف", exact: true })
        .waitFor();
      await page.route(`**/api${base}/items?**`, async (route) => {
        const response = await route.fetch();
        started();
        await released;
        await route.fulfill({ response }).catch(() => {});
      });
      const navigate = async (path: string) =>
        page.evaluate((path) => {
          window.history.pushState(
            {
              ...window.history.state,
              idx: (window.history.state?.idx ?? 0) + 1,
            },
            "",
            path,
          );
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, path);
      try {
        await navigate(`${base}/items?q=فلتارين`);
        await incoming;
        await navigate(`/companies/${companyB.id}/items`);
        await page
          .locator(".scope-title strong")
          .getByText(companyB.name, { exact: true })
          .waitFor();
        release();
        await page
          .getByRole("heading", { name: "الأصناف", exact: true })
          .waitFor();
        await eventually(
          () =>
            page
              .getByRole("table", { name: "جدول الأصناف" })
              .getByRole("row")
              .count(),
          (rows) => assert.equal(rows, 1),
        );
        assert.equal(
          await page
            .getByRole("cell", { name: "تعديل من مستخدم آخر", exact: true })
            .count(),
          0,
        );
        assert.equal(
          (await call<ApiPage<Item>>(owner, `/companies/${companyB.id}/items`))
            .total,
          0,
        );
      } finally {
        release();
        await page.unroute(`**/api${base}/items?**`);
      }
    },
  );
  assert.equal(
    pageErrors.length,
    0,
    `Unexpected browser errors: ${pageErrors.join("; ")}`,
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
console.log(
  `Items browser scenarios: ${passed} passed, ${failures.length} failed`,
);
assert(passed > 0, "No scenarios executed");
assert.equal(failures.length, 0, `Failed scenarios: ${failures.join(", ")}`);
