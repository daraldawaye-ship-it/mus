import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { Pool } from "pg";
import {
  chromium,
  request,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
} from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Account,
  Company,
  CompanyCurrency,
  Item,
  Page,
  SessionResponse,
} from "../packages/contracts/src/index.ts";
import type { Invoice } from "../packages/contracts/src/commerce.ts";

// This focused browser flow uses only a disposable local schema.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `browser_mixed_${randomUUID().replaceAll("-", "")}`;
const email = "owner@mixed.browser.test";
const password = "Mixed-invoice-browser-password-2026";
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let api: APIRequestContext | undefined;
let context: BrowserContext | undefined;
let session: SessionResponse = { user: null, csrf: null };
let origin = "";

async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  assert(api);
  const response = await api.fetch("/api" + path, {
    method,
    headers: {
      origin,
      ...(session.csrf ? { "x-csrf-token": session.csrf } : {}),
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

try {
  // Server origin is selected first so cookie/CSRF checks use the real browser origin.
  const probe = (await import("node:net")).createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  origin = `http://127.0.0.1:${port}`;
  app = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: true,
  });
  await provisionOwner(app.pool, {
    name: "Mixed Invoice Owner",
    displayName: "Mixed Owner",
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
  const { company } = await call<{ company: Company }>("/companies", "POST", {
    name: "شركة اختبار السطور المختلطة",
    phone: "",
    address: "",
  });
  const base = `/companies/${company.id}`;
  const currency = (
    await call<Page<CompanyCurrency>>(base + "/currencies")
  ).items.find((entry) => entry.code === "YER")!;
  const accounts: Record<string, Account> = {};
  for (const [name, category] of [
    ["عميل الاختبار", "asset"],
    ["مورد الاختبار", "liability"],
  ] as const) {
    accounts[category] = (
      await call<{ account: Account }>(base + "/accounts", "POST", {
        name,
        category,
        kind: "posting",
        parentId: null,
        normalSide: category === "asset" ? "debit" : "credit",
        cashOrBank: false,
      })
    ).account;
  }
  const branch = (await call<Page<{ id: number }>>(base + "/branches"))
    .items[0]!;
  const location = (await call<Page<{ id: number }>>(base + "/locations"))
    .items[0]!;
  const items: Record<string, Item> = {};
  for (const kind of ["sale", "purchase"] as const) {
    const item = (
      await call<{ item: Item }>(base + "/items", "POST", {
        idempotencyKey: randomUUID(),
        name: kind === "sale" ? "صنف البيع المختلط" : "صنف الشراء المختلط",
        currencyId: currency.id,
        unit1Name: "حبة",
        unit2Name: "",
        unit3Name: "",
        factor2: 1,
        factor3: 1,
        salePrice1: "10",
        salePrice2: "0",
        salePrice3: "0",
        purchasePrice: "4",
        purchaseFactor: 1,
        hasExpiry: kind === "purchase",
      })
    ).item;
    items[kind] = item;
    await call(base + "/invoices", "POST", {
      idempotencyKey: randomUUID(),
      kind: "purchase",
      documentDate: "2026-10-13",
      currencyId: currency.id,
      branchId: branch.id,
      locationId: location.id,
      counterpartyAccountId: accounts.liability!.id,
      description: "مخزون بدء اختبار",
      discount: "0",
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "10",
          unitPrice: "4",
          expiryDate: item.hasExpiry ? "2027-01-31" : null,
        },
      ],
    });
  }
  context = await browser.newContext({
    baseURL: origin,
    storageState: await api.storageState(),
    timezoneId: "Asia/Aden",
    viewport: { width: 1440, height: 960 },
  });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  for (const [kind, negativeQuantity, expectedTotal] of [
    ["sale", "-2", "-10"],
    ["purchase", "-2", "-4"],
    ["sale", "-1", "0"],
  ] as const) {
    const item = items[kind]!;
    await page.goto(base + `/invoices/new?kind=${kind}`);
    const searches = page.locator('[id^="invoice-item-search-"]');
    await searches.first().waitFor();
    await page
      .getByLabel(
        kind === "sale" ? "حساب العميل / النقد" : "حساب المورد / النقد",
        { exact: true },
      )
      .selectOption(
        String(accounts[kind === "sale" ? "asset" : "liability"]!.id),
      );
    await page.getByLabel("تاريخ الفاتورة", { exact: true }).fill("2026-10-13");
    for (const [index, quantity] of ["1", negativeQuantity].entries()) {
      await searches.nth(index).fill(item.name);
      await page
        .getByRole("listbox", { name: "نتائج الأصناف" })
        .getByRole("button", { name: new RegExp(item.name) })
        .click();
      const quantities = page.locator('[id^="invoice-quantity-"]');
      assert.equal(await quantities.nth(index).inputValue(), "1");
      assert.equal(
        await quantities
          .nth(index)
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await quantities.nth(index).fill(quantity);
      await quantities.nth(index).press("Enter");
      if (kind === "purchase") {
        const price = page.locator('[id^="invoice-price-"]').nth(index);
        assert.equal(
          await price.evaluate((node) => node === document.activeElement),
          true,
        );
        await price.fill("4");
        await price.press("Enter");
        const expiry = page.locator('[id^="invoice-expiry-"]').nth(index);
        assert.equal(
          await expiry.evaluate((node) => node === document.activeElement),
          true,
        );
        await expiry.fill("2027-01-31");
        await expiry.press("Enter");
      } else {
        assert.equal(
          await page
            .locator('[id^="invoice-price-"]')
            .nth(index)
            .getAttribute("readonly"),
          "",
        );
      }
      assert.equal(
        await searches
          .nth(index + 1)
          .evaluate((node) => node === document.activeElement),
        true,
      );
    }
    const quantities = page.locator('[id^="invoice-quantity-"]');
    assert.equal(
      await quantities.nth(0).inputValue(),
      "1",
      "Negative input must preserve the positive row",
    );
    assert.equal(await quantities.nth(1).inputValue(), negativeQuantity);
    assert.equal(
      await page.getByLabel("نوع العملية", { exact: true }).count(),
      0,
      "Direction is per row, with no whole-invoice return selector",
    );
    const totals = await page.locator(".commerce-totals").innerText();
    assert(
      totals.includes(expectedTotal),
      `Signed totals should include ${expectedTotal}: ${totals}`,
    );
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api${base}/invoices`) &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "حفظ وترحيل الفاتورة", exact: true })
      .click();
    const response = await responsePromise;
    const result = (await response.json()) as { invoice: Invoice };
    assert(response.ok(), JSON.stringify(result));
    assert.equal(result.invoice.kind, kind);
    assert.equal(result.invoice.mixed, true);
    assert.equal(result.invoice.returning, false);
    assert.equal(result.invoice.total, expectedTotal);
    assert.deepEqual(
      result.invoice.lines.map((line) => line.quantity),
      ["1", negativeQuantity],
    );
    assert(result.invoice.lines.every((line) => line.originalLineId === null));
    await page.getByText(/تم حفظ وترحيل الفاتورة رقم/).waitFor();
    assert.equal(await searches.first().inputValue(), "");
    assert.equal(
      await searches
        .first()
        .evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(await page.locator(".commerce-matrix tbody tr").count(), 1);
  }
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).direction,
    ),
    "rtl",
  );
  console.log(
    "PASS mixed sale and purchase compact entry preserves signed rows, keyboard flow, negative and zero net posting",
  );
} finally {
  await context?.close();
  await browser?.close();
  await api?.dispose();
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
