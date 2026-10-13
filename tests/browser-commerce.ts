import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:http";
import { Pool } from "pg";
import {
  chromium,
  request,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Account,
  AccountCategory,
  Branch,
  Company,
  CompanyCurrency,
  Item,
  Location,
  Page as ApiPage,
  SessionResponse,
} from "../packages/contracts/src/index.ts";
import type { Invoice } from "../packages/contracts/src/commerce.ts";
import type { StockBalance } from "../packages/contracts/src/inventory.ts";

// Disposable schema and test-only credentials; this runner never uses production data.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = "browser_commerce_" + process.pid + "_" + Date.now();
const password = "Commerce-browser-test-password-2026";
const email = "owner@commerce.browser.test";
const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    assert(address && typeof address !== "string");
    probe.close(() => resolve(address.port));
  });
});
const origin = "http://127.0.0.1:" + port;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let api: APIRequestContext | undefined;
let session: SessionResponse = { user: null, csrf: null };
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];
const failures: string[] = [];
let passed = 0;

async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  assert(api);
  const response = await api.fetch("/api" + path, {
    method,
    headers: {
      Origin: origin,
      ...(session.csrf ? { "x-csrf-token": session.csrf } : {}),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  const result: unknown = await response.json();
  assert(
    response.ok(),
    method +
      " " +
      path +
      ": " +
      response.status() +
      " " +
      JSON.stringify(result),
  );
  return result as T;
}
async function pageFor(mobile = false) {
  assert(browser && api);
  const context = await browser.newContext({
    baseURL: origin,
    storageState: await api.storageState(),
    timezoneId: "Asia/Aden",
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 960 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  context.setDefaultTimeout(15000);
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return page;
}
async function scenario(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name);
    console.error("FAIL " + name, error);
    const page = contexts.at(-1)?.pages().at(-1);
    await page
      ?.screenshot({
        path: "/workspace/work/commerce-failure-" + failures.length + ".png",
        fullPage: true,
      })
      .catch(() => {});
  }
}
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => void,
) {
  let last: unknown;
  const deadline = Date.now() + 15000;
  do {
    try {
      const value = await read();
      check(value);
      return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw last;
}
async function geometry(page: Page, width: number) {
  const actual = await page.evaluate(() => ({
    direction: getComputedStyle(document.documentElement).direction,
    width: innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.equal(actual.direction, "rtl");
  assert.equal(actual.width, width);
  assert(
    actual.html <= width + 1 && actual.body <= width + 1,
    "Page overflow: " + JSON.stringify(actual),
  );
  const header = await page.evaluate(() => {
    const card = document.querySelector(".commerce-header-card");
    const content = document.querySelector(".commerce-header-content");
    return card && content
      ? {
          height: card.getBoundingClientRect().height,
          viewport: innerHeight,
          scrolls: content.scrollHeight > content.clientHeight,
          overflow: getComputedStyle(content).overflowY,
        }
      : null;
  });
  if (header) {
    assert(
      header.height <= 111 && header.height < header.viewport * 0.3,
      "Invoice header should stay compact while its right half scrolls",
    );
    assert.equal(header.overflow, "auto");
    assert(header.scrolls, "The occupied header half must have vertical scroll");
    const order = await page.locator(".commerce-header-content").evaluate((element) => ({
      firstLabel: element.children.item(0)?.textContent?.trim() ?? "",
      secondLabel: element.children.item(1)?.textContent?.trim() ?? "",
      linkInside: !!element.querySelector(".commerce-list-link"),
    }));
    assert.match(order.firstLabel, /حساب العميل|حساب المورد/);
    assert.match(order.secondLabel, /قائمة الفواتير/);
    assert.equal(order.linkInside, true);
    assert.equal(await page.locator(".commerce-document-page > .page-header").count(), 0);
  }
  const footer = page.locator(".commerce-save-footer");
  if (await footer.count()) {
    const bounds = await footer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        viewport: innerHeight,
        position: getComputedStyle(element).position,
        left: rect.left,
        right: rect.right,
        width: innerWidth,
      };
    });
    assert.equal(bounds.position, "static");
    assert(bounds.bottom > 0);
    // Unlike the former fixed footer, this section must follow the matrix.
    const followsRows = await footer.evaluate((element) => {
      const matrix = document.querySelector(".commerce-matrix-card");
      if (!matrix) return false;
      return !!(matrix.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.equal(followsRows, true);
    assert(bounds.left >= 0 && bounds.right <= bounds.width + 1);
  }
}

try {
  await mkdir("/workspace/work", { recursive: true });
  app = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: true,
  });
  await provisionOwner(app.pool, {
    name: "Commerce Browser Owner",
    displayName: "Commerce Owner",
    email,
    password,
  });
  server = app.app.listen(port, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  api = await request.newContext({ baseURL: origin });
  session = await call<SessionResponse>("/auth/login", "POST", {
    email,
    password,
  });
  const company = (
    await call<{ company: Company }>("/companies", "POST", {
      name: "شركة اختبار التشغيل",
      phone: "",
      address: "صنعاء",
    })
  ).company;
  const base = "/companies/" + company.id;
  await call(base + "/currencies/initialize", "POST", { baseCurrency: "YER" });
  const currency = (
    await call<ApiPage<CompanyCurrency>>(base + "/currencies")
  ).items.find((value) => value.code === "YER")!;
  const accounts: Record<string, Account> = {};
  const accountSpecs: [string, AccountCategory][] = [
    ["inventory", "asset"],
    ["salesRevenue", "income"],
    ["costOfGoodsSold", "expense"],
    ["stockSurplus", "income"],
    ["stockShortage", "expense"],
    ["discountAllowed", "expense"],
    ["customer", "asset"],
    ["supplier", "liability"],
  ];
  for (const [index, [name, category]] of accountSpecs.entries()) {
    accounts[name] = (
      await call<{ account: Account }>(base + "/accounts", "POST", {
        code: String(index + 1).padStart(10, "0"),
        name,
        category,
        kind: "posting",
        parentId: null,
        normalSide:
          category === "asset" || category === "expense" ? "debit" : "credit",
        cashOrBank: false,
      })
    ).account;
  }
  await call(base + "/account-links/discountAllowed", "PUT", {
    accountId: accounts.discountAllowed!.id,
  });
  await call(base + "/inventory-settings", "PUT", {
    inventoryAccountId: accounts.inventory!.id,
    salesAccountId: accounts.salesRevenue!.id,
    cogsAccountId: accounts.costOfGoodsSold!.id,
    surplusAccountId: accounts.stockSurplus!.id,
    shortageAccountId: accounts.stockShortage!.id,
    costingMethod: "weighted_average",
    allowNegative: false,
    revision: null,
  });
  const branch = (await call<ApiPage<Branch>>(base + "/branches")).items[0]!;
  const showroom = (await call<ApiPage<Location>>(base + "/locations"))
    .items[0]!;
  const warehouse = (
    await call<{ location: Location }>(base + "/locations", "POST", {
      branchId: branch.id,
      code: "W1",
      name: "مخزن الاختبار",
      kind: "warehouse",
    })
  ).location;
  const item = (
    await call<{ item: Item }>(base + "/items", "POST", {
      idempotencyKey: randomUUID(),
      name: "صنف التشغيل",
      barcode: "123456789",
      currencyId: currency.id,
      unit1Name: "باكت",
      unit2Name: "شريط",
      unit3Name: "حبة",
      factor2: 2,
      factor3: 12,
      salePrice1: "120",
      salePrice2: "60",
      salePrice3: "5",
      purchasePrice: "72",
      purchaseFactor: 3,
      hasExpiry: true,
    })
  ).item;
  // First release can run the inventory-only scenarios before invoice routes exist.
  await call(base + "/stock-adjustments", "POST", {
    idempotencyKey: randomUUID(),
    documentDate: "2026-10-12",
    itemId: item.id,
    locationId: showroom.id,
    countedQuantity: "10",
    expectedQuantitySmallest: "0",
    unit: 1,
    expiryDate: "2027-01-31",
    unitCostBase: "72",
    description: "مخزون اختبار معلن",
  });
  const page = await pageFor();
  // Additional scenarios are appended once the corresponding UI slices are ready.
  await scenario(
    "inventory balances render exact company-scoped stock and RTL",
    async () => {
      await page.goto(base + "/stock-balances");
      await page.getByText(item.name, { exact: true }).first().waitFor();
      await geometry(page, 1440);
      const balances = await call<ApiPage<StockBalance>>(
        base + "/stock-balances?itemId=" + item.id,
      );
      assert.equal(balances.items[0]!.quantitySmallest, "240");
      assert.equal(balances.items[0]!.pooledValueBase, "720");
    },
  );
  async function choose(page: Page, label: string, optionId: number) {
    await page
      .getByRole("button", { name: new RegExp("^" + label + ":") })
      .click();
    const dialog = page.getByRole("dialog", { name: "اختيار " + label });
    await dialog
      .getByLabel(label, { exact: true })
      .selectOption(String(optionId));
    await dialog.waitFor({ state: "hidden" });
  }
  await scenario(
    "inventory transfer and counted adjustment persist exact linked movements",
    async () => {
      await page.goto(base + "/stock-operations");
      await page.getByLabel("نوع العملية", { exact: true }).waitFor();
      await choose(page, "الصنف", item.id);
      await choose(page, "موقع الإرسال", showroom.id);
      await choose(page, "موقع الاستلام", warehouse.id);
      await page
        .getByLabel("تاريخ المستند", { exact: true })
        .fill("2026-10-12");
      await page.getByLabel("الوحدة", { exact: true }).selectOption("3");
      await page.getByLabel("كمية المناقلة", { exact: true }).fill("24");
      await page
        .getByLabel("تاريخ انتهاء الدفعة", { exact: true })
        .fill("2027-01-31");
      await page
        .getByRole("button", { name: "ترحيل المناقلة", exact: true })
        .click();
      await page
        .getByRole("button", { name: "بدء عملية جديدة", exact: true })
        .waitFor();
      let balances = (
        await call<ApiPage<StockBalance>>(
          base + "/stock-balances?itemId=" + item.id,
        )
      ).items;
      assert.equal(
        balances.find((value) => value.locationId === warehouse.id)!
          .quantitySmallest,
        "24",
      );
      assert.equal(balances[0]!.pooledValueBase, "720");
      await page
        .getByRole("button", { name: "بدء عملية جديدة", exact: true })
        .click();
      await page
        .getByLabel("نوع العملية", { exact: true })
        .selectOption("adjustment");
      await choose(page, "الصنف", item.id);
      await choose(page, "موقع الجرد", warehouse.id);
      await page.getByLabel("الوحدة", { exact: true }).selectOption("3");
      await page
        .getByLabel("تاريخ المستند", { exact: true })
        .fill("2026-10-12");
      await page
        .getByLabel("تاريخ انتهاء الدفعة", { exact: true })
        .fill("2027-01-31");
      await page
        .getByLabel("الكمية الفعلية بعد الجرد", { exact: true })
        .fill("22");
      await page
        .getByRole("button", { name: "ترحيل تسوية الجرد", exact: true })
        .click();
      await page
        .getByRole("link", { name: "فتح القيد المحاسبي المرتبط", exact: true })
        .waitFor();
      balances = (
        await call<ApiPage<StockBalance>>(
          base + "/stock-balances?itemId=" + item.id,
        )
      ).items;
      assert.equal(
        balances.find((value) => value.locationId === warehouse.id)!
          .quantitySmallest,
        "22",
      );
      assert.equal(balances[0]!.pooledQuantitySmallest, "238");
      assert.equal(balances[0]!.pooledValueBase, "714");
    },
  );
  await scenario(
    "mobile stock pages preserve RTL dark appearance without page overflow",
    async () => {
      await call("/appearance", "PATCH", {
        scope: "company:" + company.id,
        mode: "dark",
        color: "#2563eb",
      });
      const mobile = await pageFor(true);
      for (const path of [
        "stock-balances",
        "stock-movements",
        "stock-operations",
        "inventory-settings",
      ]) {
        await mobile.goto(base + "/" + path);
        await eventually(
          () => mobile.locator(".scope-title strong").textContent(),
          (value) => assert.equal(value, company.name),
        );
        await mobile.locator(".page-heading").first().waitFor();
        await geometry(mobile, 390);
      }
      await mobile.screenshot({
        path: "/workspace/work/inventory-mobile.png",
        fullPage: true,
      });
    },
  );
  if (process.env.COMMERCE_BROWSER_INVENTORY_ONLY !== "1") {
    let savedSale: Invoice | undefined;
    await scenario(
      "entire invoice header scrolls in right half; left half stays empty",
      async () => {
        for (const kind of ["sale", "purchase"] as const) {
          await page.goto(base + "/invoices/new?kind=" + kind);
          await page.locator("form.commerce-editor").waitFor();
          const halves = await page.locator(".commerce-header-grid > div")
            .evaluateAll((nodes) => nodes.map((element) => {
              const rect = element.getBoundingClientRect();
              return { width: rect.width, top: rect.top };
            }));
          assert.equal(halves.length, 2);
          assert(Math.abs(halves[0]!.width - halves[1]!.width) <= 2,
            "Both header halves must be equal: " + JSON.stringify(halves));
          assert(Math.abs(halves[0]!.top - halves[1]!.top) <= 2);
          const occupied = page.locator(".commerce-header-content");
          const blank = page.locator(".commerce-header-blank");
          assert.equal(await blank.innerText(), "");
          assert.equal(await blank.locator("input,button,a,select").count(), 0);
          assert.equal(await occupied.getByLabel(
            kind === "sale" ? "حساب العميل / النقد" : "حساب المورد / النقد").count(), 1);
          assert.equal(await occupied.getByLabel("تاريخ الفاتورة").count(), 1);
          assert.equal(await occupied.getByLabel("عملة الفاتورة").count(), 1);
          assert.equal(await occupied.getByLabel("الفرع").count(), 1);
          assert.equal(await occupied.getByLabel("المعرض / المخزن").count(), 1);
          await occupied.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          assert((await occupied.evaluate((node) => node.scrollTop)) > 0,
            "Only the occupied half should scroll down to the remaining fields");
        }
        await geometry(page, 1440);
      },
    );
    await scenario(
      "invoice purchase screen supports keyboard entry and exact totals",
      async () => {
        await page.goto(base + "/invoices/new?kind=purchase");
        await page.locator("form.commerce-editor").waitFor();
        assert.equal(
          await page.locator('[id^="invoice-item-search-"]').first()
            .evaluate((input) => input === document.activeElement),
          true,
          "New purchase invoice should focus the first item search",
        );
        await page
          .getByLabel("عملة الفاتورة", { exact: true })
          .selectOption(String(currency.id));
        await page
          .getByLabel("حساب المورد / النقد", { exact: true })
          .selectOption(String(accounts.supplier!.id));
        await page
          .getByLabel("الفرع", { exact: true })
          .selectOption(String(branch.id));
        await page
          .getByLabel("المعرض / المخزن", { exact: true })
          .selectOption(String(showroom.id));
        await page
          .getByLabel("تاريخ الفاتورة", { exact: true })
          .fill("2026-10-12");
        await page
          .locator('[id^="invoice-item-search-"]')
          .first()
          .fill(item.barcode);
        await page
          .getByRole("listbox", { name: "نتائج الأصناف" })
          .getByRole("button", { name: new RegExp(item.name) })
          .click();
        assert.equal(
          await page
            .locator('[id^="invoice-quantity-"]')
            .first()
            .evaluate((element) => element === document.activeElement),
          true,
        );
        await page.locator('[id^="invoice-quantity-"]').first().fill("2");
        await page.locator('[id^="invoice-quantity-"]').first().press("Enter");
        assert.equal(
          await page
            .locator('[id^="invoice-price-"]')
            .first()
            .evaluate((element) => element === document.activeElement),
          true,
        );
        await page.locator('[id^="invoice-price-"]').first().fill("72");
        await page.locator('[id^="invoice-price-"]').first().press("Enter");
        await page
          .locator('[id^="invoice-expiry-"]')
          .first()
          .fill("2027-02-28");
        await page.locator('[id^="invoice-expiry-"]').first().press("Enter");
        await page.getByLabel("الخصم", { exact: true }).fill("4");
        assert.match(await page.locator(".commerce-totals").innerText(), /140/);
        await page
          .getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true })
          .click();
        await page
          .getByText(/تم حفظ وترحيل الفاتورة رقم/)
          .waitFor();
        assert.equal(await page.locator("form.commerce-editor > .commerce-header-card")
          .evaluate((header) => Boolean(header.nextElementSibling?.textContent?.includes(
            "تم حفظ وترحيل الفاتورة رقم",
          ))), true, "Save confirmation belongs immediately below the header");
        const readyItem1 = page.locator('[id^="invoice-item-search-"]').first();
        await readyItem1.waitFor();
        assert.equal(await readyItem1.inputValue(), "");
        assert.equal(
          await readyItem1.evaluate((node) => node === document.activeElement),
          true,
          "After saving, focus should return to an empty item search",
        );
        assert.equal(await page.locator(".commerce-matrix tbody tr").count(), 1);
        assert.equal(await page.locator(".commerce-matrix tr[data-selected='true']").count(), 0);
        assert.match(page.url(), /\/invoices\/new\?kind=(purchase|sale)$/);
        const invoices = await call<ApiPage<Invoice>>(
          base + "/invoices?kind=purchase",
        );
        assert.equal(invoices.items.length, 1);
        assert.equal(invoices.items[0]!.total, "140");
        assert.equal(invoices.items[0]!.lines[0]!.smallestQuantity, "48");
        await geometry(page, 1440);
      },
    );
    await scenario(
      "reset clears purchase and sale invoice drafts and restores first-item focus",
      async () => {
        for (const kind of ["purchase", "sale"] as const) {
          await page.goto(base + "/invoices/new?kind=" + kind);
          await page.locator("form.commerce-editor").waitFor();
          await page.getByLabel(
            kind === "sale" ? "حساب العميل / النقد" : "حساب المورد / النقد",
            { exact: true },
          ).selectOption(String(kind === "sale" ? accounts.customer!.id : accounts.supplier!.id));
          await page.getByLabel("تاريخ الفاتورة", { exact: true }).fill("2026-01-01");
          await page.getByLabel("ملاحظات الفاتورة", { exact: true }).fill("ملاحظة للتصفير");
          await page.locator('[id^="invoice-item-search-"]').first().fill(item.barcode);
          await page.getByRole("listbox", { name: "نتائج الأصناف" })
            .getByRole("button", { name: new RegExp(item.name) }).click();
          await page.getByLabel("الخصم", { exact: true }).fill("15");
          await page.getByRole("button", { name: "تصفير الفاتورة", exact: true }).click();
          const search = page.locator('[id^="invoice-item-search-"]').first();
          assert.equal(await search.inputValue(), "");
          assert.equal(await page.locator(".commerce-matrix tbody tr").count(), 1);
          assert.equal(await page.getByLabel("ملاحظات الفاتورة", { exact: true }).inputValue(), "");
          assert.equal(await page.getByLabel("الخصم", { exact: true }).inputValue(), "0");
          assert.notEqual(await page.getByLabel("تاريخ الفاتورة", { exact: true }).inputValue(), "2026-01-01");
          assert.equal(
            await page.getByLabel(
              kind === "sale" ? "حساب العميل / النقد" : "حساب المورد / النقد",
              { exact: true },
            ).inputValue(),
            "",
          );
          assert.equal(await search.evaluate((node) => node === document.activeElement), true);
          assert.equal(
            await page.getByText("على السطور الموجبة فقط؛ خصم المردود المرتبط من الأصل").count(),
            0,
          );
          const footerHeight = await page.locator(".commerce-save-footer")
            .evaluate((element) => element.getBoundingClientRect().height);
          assert(footerHeight <= 95,
            "Invoice footer should remain compact on desktop: " + footerHeight);
          assert.match(page.url(), new RegExp("/invoices/new\\?kind=" + kind));
        }
      },
    );
    async function saleDraft(quantity: string) {
      await page.goto(base + "/invoices/new?kind=sale");
      await page.locator('[id^="invoice-item-search-"]').first().waitFor();
      assert.equal(
        await page.locator('[id^="invoice-item-search-"]').first()
          .evaluate((input) => input === document.activeElement),
        true,
        "New sales invoice should focus the first item search",
      );
      await page
        .getByRole("heading", { name: "إضافة فاتورة مبيعات", exact: true })
        .waitFor();
      await page
        .getByLabel("عملة الفاتورة", { exact: true })
        .selectOption(String(currency.id));
      await page
        .getByLabel("حساب العميل / النقد", { exact: true })
        .selectOption(String(accounts.customer!.id));
      await page
        .getByLabel("الفرع", { exact: true })
        .selectOption(String(branch.id));
      await page
        .getByLabel("المعرض / المخزن", { exact: true })
        .selectOption(String(showroom.id));
      assert.equal(
        await page
          .getByLabel("المعرض / المخزن", { exact: true })
          .locator('option[value="' + warehouse.id + '"]')
          .count(),
        0,
      );
      await page
        .getByLabel("تاريخ الفاتورة", { exact: true })
        .fill("2026-10-12");
      // A scanner may send Enter before the debounce completes.
      await page
        .locator('[id^="invoice-item-search-"]')
        .first()
        .fill(item.barcode);
      await page.locator('[id^="invoice-item-search-"]').first().press("Enter");
      await eventually(
        () => page.locator('[id^="invoice-price-"]').first().inputValue(),
        (value) => assert.equal(value, "120"),
      );
      await page
        .getByLabel("الوحدة " + item.name, { exact: true })
        .selectOption("3");
      assert.equal(
        await page.locator('[id^="invoice-price-"]').first().inputValue(),
        "5",
      );
      assert.equal(
        await page
          .locator('[id^="invoice-price-"]')
          .first()
          .getAttribute("readonly"),
        "",
      );
      assert.equal(
        await page.locator('[id^="invoice-expiry-"]').first().count(),
        0,
      );
      await page.locator('[id^="invoice-quantity-"]').first().fill(quantity);
      await page.locator('[id^="invoice-quantity-"]').first().press("Enter");
    }
    await scenario(
      "sales stock stays in first item unit with one decimal when sale unit changes",
      async () => {
        await saleDraft("3");
        const preview = await call<{
          items: { itemId: number; quantitySmallest: string }[];
        }>(base + "/invoice-stock-preview?locationId=" + showroom.id +
          "&itemIds=" + item.id);
        const available = preview.items.find((entry) => entry.itemId === item.id)!;
        const expected = Number((
          Number(available.quantitySmallest) / (item.factor2 * item.factor3)
        ).toFixed(1)).toString();
        const stock = page.locator(".commerce-matrix tr[data-selected='true']")
          .first().locator(".commerce-line-available");
        await eventually(() => stock.innerText(), (shown) =>
          assert.equal(shown.trim(), expected));
        for (const saleUnit of ["1", "2", "3"]) {
          await page.getByLabel("الوحدة " + item.name, { exact: true })
            .selectOption(saleUnit);
          assert.equal((await stock.innerText()).trim(), expected,
            "Available stock must not switch from first unit to sale unit " + saleUnit);
        }
        await page.getByRole("button", { name: "تصفير الفاتورة", exact: true }).click();
      },
    );
    await scenario(
      "RTL arrows navigate sales and purchases within one invoice line",
      async () => {
        const focused = async (locator: import("playwright").Locator) =>
          assert.equal(await locator.evaluate((node) => node === document.activeElement),
            true, "Arrow must move focus to the expected invoice control");

        await saleDraft("3");
        const salesRow = page.locator(".commerce-matrix tr[data-selected='true']").first();
        const salesSearch = salesRow.locator('input[id^="invoice-item-search-"]');
        const salesUnit = salesRow.getByLabel("الوحدة " + item.name, { exact: true });
        const salesQuantity = salesRow.locator('input[id^="invoice-quantity-"]');
        const salesPrice = salesRow.locator('input[id^="invoice-price-"]');
        await salesQuantity.focus();
        await salesQuantity.press("ArrowRight");
        await focused(salesUnit);
        await salesUnit.press("ArrowLeft");
        await focused(salesQuantity);
        await salesQuantity.press("ArrowLeft");
        await focused(salesPrice);
        await salesPrice.press("ArrowRight");
        await focused(salesQuantity);
        await salesUnit.focus();
        await salesUnit.press("ArrowRight");
        await focused(salesSearch);
        await salesSearch.press("ArrowLeft");
        await focused(salesUnit);
        const firstAction = salesRow.locator("button:not(:disabled)").first();
        await salesPrice.focus();
        await salesPrice.press("ArrowLeft");
        await focused(firstAction);
        await firstAction.press("ArrowRight");
        await focused(salesPrice);
        assert.equal(await salesQuantity.inputValue(), "3");
        assert.equal(await salesUnit.inputValue(), "3");
        assert.equal(await salesRow.count(), 1);
        await page.getByRole("button", { name: "تصفير الفاتورة", exact: true }).click();

        await page.goto(base + "/invoices/new?kind=purchase");
        await page.locator("form.commerce-editor").waitFor();
        await page.locator('[id^="invoice-item-search-"]').first().fill(item.barcode);
        await page.getByRole("listbox", { name: "نتائج الأصناف" })
          .getByRole("button", { name: new RegExp(item.name) }).click();
        const purchaseRow = page.locator(".commerce-matrix tr[data-selected='true']").first();
        const purchaseUnit = purchaseRow.getByLabel("الوحدة " + item.name, { exact: true });
        const purchaseQuantity = purchaseRow.locator('input[id^="invoice-quantity-"]');
        const purchasePrice = purchaseRow.locator('input[id^="invoice-price-"]');
        const purchaseExpiry = purchaseRow.locator('input[id^="invoice-expiry-"]');
        await purchaseQuantity.press("ArrowRight");
        await focused(purchaseUnit);
        await purchaseUnit.press("ArrowLeft");
        await focused(purchaseQuantity);
        await purchaseQuantity.press("ArrowLeft");
        await focused(purchasePrice);
        await purchasePrice.press("ArrowLeft");
        await focused(purchaseExpiry);
        await purchaseExpiry.press("ArrowRight");
        await focused(purchasePrice);
        assert.equal(await purchaseQuantity.inputValue(), "1");
        assert.equal(await purchaseRow.count(), 1);
        await page.getByRole("button", { name: "تصفير الفاتورة", exact: true }).click();
      },
    );
    await scenario(
      "sales keyboard shortcut: zero Enter, notes Enter, discount Enter, then focused Save",
      async () => {
        const before = await call<ApiPage<Invoice>>(base + "/invoices?kind=sale");
        await saleDraft("3");
        const search = page.locator('[id^="invoice-item-search-"]').last();
        await search.fill("0");
        await search.press("Enter");
        const notes = page.getByLabel("ملاحظات الفاتورة", { exact: true });
        assert.equal(await search.inputValue(), "", "Zero must be cleared");
        assert.equal(await notes.evaluate((input) => input === document.activeElement), true);
        assert.equal(await page.locator(".commerce-matrix tr[data-selected='true']").count(), 1);
        await notes.fill("فاتورة بالاختصار");
        await notes.press("Enter");
        const discount = page.getByLabel("الخصم", { exact: true });
        assert.equal(await discount.evaluate((input) => input === document.activeElement), true);
        await discount.fill("1");
        await discount.press("Enter");
        const save = page.getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true });
        assert.equal(await save.evaluate((input) => input === document.activeElement), true);
        assert.equal(await notes.inputValue(), "فاتورة بالاختصار");
        assert.equal(await discount.inputValue(), "1");
        assert.equal((await call<ApiPage<Invoice>>(base + "/invoices?kind=sale")).total,
          before.total, "Enter in notes and discount must never auto-save");
        await page.getByRole("button", { name: "تصفير الفاتورة", exact: true }).click();

        // Purchases retain the normal item search workflow; zero is not a shortcut.
        await page.goto(base + "/invoices/new?kind=purchase");
        const purchaseSearch = page.locator('[id^="invoice-item-search-"]').first();
        await purchaseSearch.fill("0");
        await purchaseSearch.press("Enter");
        assert.equal(await purchaseSearch.inputValue(), "0");
        assert.equal(await purchaseSearch.evaluate((input) => input === document.activeElement), true);
        await page.getByRole("button", { name: "تصفير الفاتورة", exact: true }).click();
      },
    );
    await scenario(
      "sales preserve authoritative unit prices, showroom selection and linked discounted return",
      async () => {
        await saleDraft("3");
        await page.getByLabel("الخصم", { exact: true }).fill("1");
        assert.match(await page.locator(".commerce-totals").innerText(), /14/);
        await page
          .getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true })
          .click();
        await page
          .getByText(/تم حفظ وترحيل الفاتورة رقم/)
          .waitFor();
        const readyItem2 = page.locator('[id^="invoice-item-search-"]').first();
        await readyItem2.waitFor();
        assert.equal(await readyItem2.inputValue(), "");
        assert.equal(
          await readyItem2.evaluate((node) => node === document.activeElement),
          true,
          "After saving, focus should return to an empty item search",
        );
        assert.equal(await page.locator(".commerce-matrix tbody tr").count(), 1);
        assert.equal(await page.locator(".commerce-matrix tr[data-selected='true']").count(), 0);
        assert.match(page.url(), /\/invoices\/new\?kind=(purchase|sale)$/);
        savedSale = (
          await call<ApiPage<Invoice>>(
            base + "/invoices?kind=sale&returning=false",
          )
        ).items[0]!;
        assert.equal(savedSale.total, "14");
        assert.equal(savedSale.lines[0]!.quantity, "3");
        assert.equal(savedSale.lines[0]!.unitPrice, "5");
        assert(savedSale.costDocumentId);
        await page.goto(base + "/invoices/new?kind=sale");
        await page
          .getByRole("button", { name: "ربط مردود بأصل", exact: true })
          .click();
        await page
          .getByLabel("الفاتورة الأصلية", { exact: true })
          .selectOption(String(savedSale.id));
        await page
          .getByLabel("الصنف المرتجع من الأصل", { exact: true })
          .selectOption(String(savedSale.lines[0]!.id));
        await page
          .getByLabel("تاريخ الفاتورة", { exact: true })
          .fill("2026-10-12");
        await page.locator('[id^="invoice-quantity-"]').first().press("Enter");
        await page
          .getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true })
          .click();
        await page
          .getByText(/تم حفظ وترحيل الفاتورة رقم/)
          .waitFor();
        const readyItem3 = page.locator('[id^="invoice-item-search-"]').first();
        await readyItem3.waitFor();
        assert.equal(await readyItem3.inputValue(), "");
        assert.equal(
          await readyItem3.evaluate((node) => node === document.activeElement),
          true,
          "After saving, focus should return to an empty item search",
        );
        assert.equal(await page.locator(".commerce-matrix tbody tr").count(), 1);
        assert.equal(await page.locator(".commerce-matrix tr[data-selected='true']").count(), 0);
        assert.match(page.url(), /\/invoices\/new\?kind=(purchase|sale)$/);
        const returned = (
          await call<ApiPage<Invoice>>(
            base + "/invoices?kind=sale&returning=true",
          )
        ).items[0]!;
        assert.equal(returned.total, "-4.67");
        assert.equal(returned.lines[0]!.originalLineId, savedSale.lines[0]!.id);
        assert.equal(returned.lines[0]!.quantity, "-1");
      },
    );
    await scenario(
      "unknown invoice acknowledgement reuses its exact payload without duplicate posting",
      async () => {
        const before = (await call<ApiPage<Invoice>>(base + "/invoices")).total;
        await saleDraft("1");
        let committed = false;
        await page.route("**/api" + base + "/invoices", async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          const response = await route.fetch();
          assert.equal(response.status(), 201);
          committed = true;
          await route.abort("failed");
        });
        await page
          .getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true })
          .click();
        await page
          .getByRole("button", { name: "تأكيد نتيجة الطلب نفسه", exact: true })
          .waitFor();
        assert(committed);
        assert.equal(
          (await call<ApiPage<Invoice>>(base + "/invoices")).total,
          before + 1,
        );
        await page.unroute("**/api" + base + "/invoices");
        await page
          .getByRole("button", { name: "تأكيد نتيجة الطلب نفسه", exact: true })
          .click();
        await page.waitForURL("**" + base + "/sales");
        assert.equal(
          (await call<ApiPage<Invoice>>(base + "/invoices")).total,
          before + 1,
        );
      },
    );
    await scenario(
      "invoice views print in readable colors and retain mobile RTL geometry",
      async () => {
        assert(savedSale);
        await page.goto(base + "/invoices/" + savedSale.id);
        await page.locator(".commerce-print-document").waitFor();
        await page.screenshot({
          path: "/workspace/work/invoice-desktop.png",
          fullPage: true,
        });
        await page.emulateMedia({ media: "print" });
        assert.equal(
          await page
            .getByRole("button", { name: "طباعة", exact: true })
            .isVisible(),
          false,
        );
        const colors = await page
          .locator(".commerce-print-document td")
          .first()
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return { color: style.color, background: style.backgroundColor };
          });
        assert.equal(colors.color, "rgb(17, 17, 17)");
        assert.equal(colors.background, "rgb(255, 255, 255)");
        await page.emulateMedia({ media: "screen" });
        const mobile = await pageFor(true);
        for (const destination of [
          "/invoices/" + savedSale.id,
          "/invoices/new?kind=purchase",
          "/invoices/new?kind=sale",
        ]) {
          await mobile.goto(base + destination);
          await mobile.locator(".page-heading").first().waitFor();
          await geometry(mobile, 390);
        }
        await mobile.screenshot({
          path: "/workspace/work/invoice-mobile.png",
          fullPage: true,
        });
      },
    );
    await scenario(
      "fully discounted purchases and linked zero-net returns save and render without empty journal links",
      async () => {
        await page.goto(base + "/invoices/new?kind=purchase");
        await page.locator("form.commerce-editor").waitFor();
        await page
          .getByLabel("عملة الفاتورة", { exact: true })
          .selectOption(String(currency.id));
        await page
          .getByLabel("حساب المورد / النقد", { exact: true })
          .selectOption(String(accounts.supplier!.id));
        await page
          .getByLabel("الفرع", { exact: true })
          .selectOption(String(branch.id));
        await page
          .getByLabel("المعرض / المخزن", { exact: true })
          .selectOption(String(showroom.id));
        await page
          .getByLabel("تاريخ الفاتورة", { exact: true })
          .fill("2026-10-12");
        await page
          .locator('[id^="invoice-item-search-"]')
          .first()
          .fill(item.barcode);
        await page
          .getByRole("listbox", { name: "نتائج الأصناف" })
          .getByRole("button", { name: new RegExp(item.name) })
          .click();
        await page.locator('[id^="invoice-quantity-"]').first().press("Enter");
        await page.locator('[id^="invoice-price-"]').first().press("Enter");
        await page
          .locator('[id^="invoice-expiry-"]')
          .first()
          .fill("2027-01-31");
        assert.equal(
          await page.locator(".commerce-matrix tbody tr").count(),
          1,
        );
        await page.getByLabel("الخصم", { exact: true }).fill("72");
        await page
          .getByText(
            "الصافي صفر؛ سيُحفظ أثر الأصناف والتكلفة، دون مبلغ على الحساب المقابل.",
          )
          .waitFor();
        await page
          .getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true })
          .click();
        await page
          .getByText(/تم حفظ وترحيل الفاتورة رقم/)
          .waitFor();
        const readyItem4 = page.locator('[id^="invoice-item-search-"]').first();
        await readyItem4.waitFor();
        assert.equal(await readyItem4.inputValue(), "");
        assert.equal(
          await readyItem4.evaluate((node) => node === document.activeElement),
          true,
          "After saving, focus should return to an empty item search",
        );
        assert.equal(await page.locator(".commerce-matrix tbody tr").count(), 1);
        assert.equal(await page.locator(".commerce-matrix tr[data-selected='true']").count(), 0);
        assert.match(page.url(), /\/invoices\/new\?kind=(purchase|sale)$/);
        const zero = (
          await call<ApiPage<Invoice>>(
            base + "/invoices?kind=purchase&sort=id:desc",
          )
        ).items[0]!;
        assert.equal(zero.total, "0");
        assert.equal(zero.financialDocumentId, null);
        assert.equal(zero.returning, false);
        await page.goto(base + "/invoices/" + zero.id);
        await page
          .getByText(
            "صافي المستند صفر؛ لا يوجد مبلغ مستحق أو مردود على الحساب المقابل.",
          )
          .waitFor();
        assert.equal(
          await page
            .getByRole("link", { name: "القيد المحاسبي", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.locator('a[href$="/financial-documents/null"]').count(),
          0,
        );
        await page.goto(base + "/invoices/new?kind=purchase");
        await page
          .getByRole("button", { name: "ربط مردود بأصل", exact: true })
          .click();
        await page
          .getByLabel("الفاتورة الأصلية", { exact: true })
          .selectOption(String(zero.id));
        await page
          .getByLabel("الصنف المرتجع من الأصل", { exact: true })
          .selectOption(String(zero.lines[0]!.id));
        await page
          .getByLabel("تاريخ الفاتورة", { exact: true })
          .fill("2026-10-12");
        await page.locator('[id^="invoice-quantity-"]').first().press("Enter");
        await page
          .getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true })
          .click();
        await page
          .getByText(/تم حفظ وترحيل الفاتورة رقم/)
          .waitFor();
        const readyItem5 = page.locator('[id^="invoice-item-search-"]').first();
        await readyItem5.waitFor();
        assert.equal(await readyItem5.inputValue(), "");
        assert.equal(
          await readyItem5.evaluate((node) => node === document.activeElement),
          true,
          "After saving, focus should return to an empty item search",
        );
        assert.equal(await page.locator(".commerce-matrix tbody tr").count(), 1);
        assert.equal(await page.locator(".commerce-matrix tr[data-selected='true']").count(), 0);
        assert.match(page.url(), /\/invoices\/new\?kind=(purchase|sale)$/);
        const returned = (
          await call<ApiPage<Invoice>>(
            base + "/invoices?kind=purchase&returning=true",
          )
        ).items[0]!;
        assert.equal(returned.total, "0");
        assert.equal(returned.returning, true);
        assert.equal(returned.financialDocumentId, null);
        assert.equal(returned.lines[0]!.originalLineId, zero.lines[0]!.id);
        assert(returned.varianceDocumentId);
      },
    );
    await scenario(
      "inline invoice matrix retains one row per item, live totals, focus, replacement and flowing footer",
      async () => {
        await saleDraft("2");
        const rows = page.locator(".commerce-matrix tbody tr");
        assert.equal(await rows.count(), 2);
        const first = rows.first();
        const second = rows.nth(1);
        assert.equal(
          await first.locator('input[type="search"]').inputValue(),
          item.name,
        );
        assert.equal(
          await second
            .locator('input[type="search"]')
            .evaluate((element) => element === document.activeElement),
          true,
        );
        assert.match(
          await first.locator(".commerce-line-total").innerText(),
          /10/,
        );
        await second.locator('input[type="search"]').fill("التشغيل");
        await page.getByRole("listbox", { name: "نتائج الأصناف" }).waitFor();
        // Results are visible outside the horizontally/vertically scrolling table.
        const popup = page.locator(".commerce-search-results");
        assert.equal(
          await popup.evaluate(
            (element) => element.parentElement === document.body,
          ),
          true,
        );
        await page
          .getByRole("listbox", { name: "نتائج الأصناف" })
          .getByRole("button", { name: new RegExp(item.name) })
          .click();
        assert.equal(
          await second.locator('[id^="invoice-quantity-"]').inputValue(),
          "1",
        );
        assert.equal(
          await second
            .locator('[id^="invoice-quantity-"]')
            .evaluate((element) => element === document.activeElement),
          true,
        );
        assert.match(
          await second.locator(".commerce-line-total").innerText(),
          /120/,
        );
        assert.match(await page.locator(".commerce-totals").innerText(), /130/);
        const rectangles = await first.locator("td").evaluateAll((cells) =>
          cells.map((cell) => {
            const rect = cell.getBoundingClientRect();
            return { top: rect.top, left: rect.left, height: rect.height };
          }),
        );
        assert.equal(rectangles.length, 8);
        assert(
          rectangles.every(
            (cell) => cell.top === rectangles[0]!.top && cell.height <= 35,
          ),
        );
        assert(
          rectangles.every(
            (cell, index) =>
              index === 0 || cell.left < rectangles[index - 1]!.left,
          ),
        );
        assert.equal(
          await page
            .getByRole("button", { name: "إضافة السطر", exact: true })
            .count(),
          0,
        );
        assert.equal(await page.getByRole("dialog").count(), 0);
        const ids = await page
          .locator('[id^="invoice-"]')
          .evaluateAll((elements) => elements.map((element) => element.id));
        assert.equal(new Set(ids).size, ids.length);
        await second
          .getByRole("button", { name: "حذف " + item.name, exact: true })
          .click();
        assert.equal(await rows.count(), 1);
        await first.getByLabel("كمية " + item.name, { exact: true }).fill("3");
        assert.match(
          await first.locator(".commerce-line-total").innerText(),
          /15/,
        );
        await first
          .getByLabel("كمية " + item.name, { exact: true })
          .press("Enter");
        await rows.nth(1).locator('input[type="search"]').fill("صنف غير مكتمل");
        await page
          .getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true })
          .click();
        await page
          .getByText(
            "اختر الصنف الجاري من نتائج البحث أو امسح البحث قبل الحفظ.",
          )
          .waitFor();
        assert.equal(
          await page
            .locator('.commerce-matrix tr[data-selected="true"]')
            .count(),
          1,
        );
        await geometry(page, 1440);
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight),
        );
        await geometry(page, 1440);
        await page.screenshot({
          path: "/workspace/work/invoice-matrix-desktop.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await geometry(page, 390);
        await page.screenshot({
          path: "/workspace/work/invoice-matrix-mobile.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 1440, height: 960 });
        // Discard through the existing guard to prepare the next scenario.
        await page
          .getByRole("link", { name: "قائمة الفواتير", exact: true })
          .click();
        await page
          .getByRole("button", { name: "مغادرة دون حفظ", exact: true })
          .click();
        await page.waitForURL("**" + base + "/sales");
      },
    );
    await scenario(
      "purchase items without expiry move quantity to price to the next inline item",
      async () => {
        const noExpiry = (
          await call<{ item: Item }>(base + "/items", "POST", {
            idempotencyKey: randomUUID(),
            name: "صنف بلا انتهاء",
            barcode: "987654321",
            currencyId: currency.id,
            unit1Name: "حبة",
            unit2Name: "",
            unit3Name: "",
            factor2: 1,
            factor3: 1,
            salePrice1: "9",
            salePrice2: "0",
            salePrice3: "0",
            purchasePrice: "6",
            purchaseFactor: 1,
            hasExpiry: false,
          })
        ).item;
        await page.goto(base + "/invoices/new?kind=purchase");
        await page
          .getByLabel("عملة الفاتورة", { exact: true })
          .selectOption(String(currency.id));
        await page
          .getByLabel("حساب المورد / النقد", { exact: true })
          .selectOption(String(accounts.supplier!.id));
        await page
          .getByLabel("الفرع", { exact: true })
          .selectOption(String(branch.id));
        await page
          .getByLabel("المعرض / المخزن", { exact: true })
          .selectOption(String(showroom.id));
        const rows = page.locator(".commerce-matrix tbody tr");
        await rows
          .first()
          .locator('input[type="search"]')
          .fill(noExpiry.barcode);
        await rows.first().locator('input[type="search"]').press("Enter");
        await eventually(
          () => rows.first().locator('[id^="invoice-price-"]').inputValue(),
          (value) => assert.equal(value, "6"),
        );
        assert.equal(
          await rows.first().locator('[id^="invoice-quantity-"]').inputValue(),
          "1",
        );
        await rows.first().locator('[id^="invoice-quantity-"]').press("Enter");
        assert.equal(
          await rows
            .first()
            .locator('[id^="invoice-price-"]')
            .evaluate((element) => element === document.activeElement),
          true,
        );
        assert.equal(
          await page
            .locator('input[type="date"][id^="invoice-expiry-"]')
            .count(),
          0,
        );
        await rows.first().locator('[id^="invoice-price-"]').fill("7");
        assert.match(
          await rows.first().locator(".commerce-line-total").innerText(),
          /7/,
        );
        await rows.first().locator('[id^="invoice-price-"]').press("Enter");
        assert.equal(await rows.count(), 2);
        assert.equal(
          await rows
            .nth(1)
            .locator('input[type="search"]')
            .evaluate((element) => element === document.activeElement),
          true,
        );
        // Replacing the item clears its old unit, price and expiry requirements in this same row.
        await rows.first().locator('input[type="search"]').fill(item.barcode);
        await rows.first().locator('input[type="search"]').press("Enter");
        await eventually(
          () => rows.first().locator('[id^="invoice-price-"]').inputValue(),
          (value) => assert.equal(value, "72"),
        );
        assert.equal(
          await rows.first().locator('input[type="date"]').count(),
          1,
        );
        await rows.first().locator('input[type="date"]').fill("2027-02-28");
        await rows
          .first()
          .locator('input[type="search"]')
          .fill(noExpiry.barcode);
        assert.equal(
          await rows.first().locator('input[type="date"]').count(),
          0,
        );
        await rows.first().locator('input[type="search"]').press("Enter");
        await eventually(
          () => rows.first().locator('[id^="invoice-price-"]').inputValue(),
          (value) => assert.equal(value, "6"),
        );
        assert.equal(
          await rows.first().locator('input[type="date"]').count(),
          0,
        );
        assert.equal(
          await rows.first().locator('[id^="invoice-quantity-"]').inputValue(),
          "1",
        );
        assert.equal(await rows.count(), 2);
        await page
          .getByRole("link", { name: "قائمة الفواتير", exact: true })
          .click();
        await page
          .getByRole("button", { name: "مغادرة دون حفظ", exact: true })
          .click();
        await page.waitForURL("**" + base + "/purchases");
      },
    );
    await scenario(
      "rejected oversell retains invoice rows and navigation guards unsaved entries",
      async () => {
        await saleDraft("999");
        await page
          .getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true })
          .click();
        await page
          .getByText(/الرصيد المتاح في الموقع أو الدفعة لا يكفي/)
          .waitFor();
        assert.equal(
          await page
            .getByLabel("كمية " + item.name, { exact: true })
            .inputValue(),
          "999",
        );
        await page
          .getByRole("link", { name: "قائمة الفواتير", exact: true })
          .click();
        await page.getByRole("dialog", { name: "مغادرة الفاتورة" }).waitFor();
        await page
          .getByRole("button", { name: "البقاء في الفاتورة", exact: true })
          .click();
        assert.equal(
          await page
            .getByLabel("كمية " + item.name, { exact: true })
            .inputValue(),
          "999",
        );
      },
    );
  }
  assert.equal(
    pageErrors.length,
    0,
    "Unexpected page errors: " + pageErrors.join("; "),
  );
} finally {
  for (const context of contexts) await context.close();
  await api?.dispose();
  await browser?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  await app?.close();
  const cleanup = new Pool({ connectionString: databaseUrl });
  try {
    await cleanup.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
  } finally {
    await cleanup.end();
  }
}
console.log(
  "Commerce browser scenarios: " +
    passed +
    " passed, " +
    failures.length +
    " failed",
);
assert(passed > 0);
assert.equal(failures.length, 0, "Failed scenarios: " + failures.join(", "));
