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

// Only the newly introduced list columns/search/filter paths, in an isolated schema.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `option_lists_browser_${randomUUID().replaceAll("-", "")}`;
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
    name: "Option list owner",
    displayName: "List owner",
    email: "browser.lists@example.test",
    password: "browser-option-lists-passphrase",
  });
  csrf = (
    await call<SessionResponse>("/auth/login", "POST", {
      email: "browser.lists@example.test",
      password: "browser-option-lists-passphrase",
    })
  ).csrf;
  const { company } = await call<{ company: { id: number } }>(
    "/companies",
    "POST",
    { name: "Browser option lists", phone: "", address: "" },
  );
  const base = `/companies/${company.id}`,
    config = base + "/configuration";
  const records: { id: number; code: string }[] = [];
  for (const suffix of ["ألف", "باء", "جيم"])
    records.push(
      (
        await call<{ account: { id: number; code: string } }>(
          base + "/accounts",
          "POST",
          {
            name: "سجل الخيارات " + suffix,
            kind: "group",
            category: "asset",
            normalSide: "debit",
            parentId: null,
          },
        )
      ).account,
    );
  const create = async (
    key: string,
    name: string,
    valueType: string,
    extra: object = {},
  ) =>
    (
      await call<{ option: { id: number } }>(config + "/options", "POST", {
        key: "browser." + key,
        name,
        valueType,
        pageKey: "company.accounts",
        recordKind: "account",
        searchable: true,
        showInList: true,
        ...extra,
      })
    ).option;
  const amount = await create("amount", "درجة العميل", "integer");
  const flag = await create("flag", "يستقبل إشعارات", "boolean");
  const choice = await create("choice", "فئة العميل", "list", {
    choices: [
      { key: "premium", label: "عميل مميز" },
      { key: "regular", label: "عميل عادي" },
    ],
  });
  for (const [index, values] of [
    [0, ["10", false, "premium"]],
    [1, ["2", true, "regular"]],
    [2, ["0", null, "premium"]],
  ] as const)
    for (const [column, definition] of [amount, flag, choice].entries())
      await call(
        config +
          `/record-options?recordKind=account&recordId=${records[index]!.id}`,
        "PUT",
        { definitionId: definition.id, value: values[column], revision: null },
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
  const table = page.getByRole("table", { name: "دليل الحسابات", exact: true });
  async function rows(expected: number[]) {
    await page.waitForFunction((ids) => {
      const table = document.querySelector('table[aria-label="دليل الحسابات"]');
      return (
        JSON.stringify(
          [...(table?.querySelectorAll("tbody tr[data-row-id]") ?? [])].map(
            (row) => Number(row.getAttribute("data-row-id")),
          ),
        ) === JSON.stringify(ids)
      );
    }, expected);
  }
  async function apply(id: number, value: string) {
    await page
      .getByLabel("تصفية حسب الخيار", { exact: true })
      .selectOption(String(id));
    await page.getByLabel("قيمة الخيار", { exact: true }).selectOption(value);
    await page
      .getByRole("button", { name: "تطبيق تصفية الخيار", exact: true })
      .click();
  }
  await page.goto(base + "/accounts?q=" + encodeURIComponent("سجل الخيارات"));
  await rows(records.map((record) => record.id));
  for (const name of ["درجة العميل", "يستقبل إشعارات", "فئة العميل"])
    await table.getByRole("columnheader", { name, exact: true }).waitFor();
  assert.equal(
    await table
      .locator(`tr[data-row-id="${records[0]!.id}"]`)
      .getByText("لا", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await table
      .locator(`tr[data-row-id="${records[2]!.id}"]`)
      .getByText("غير محدد", { exact: true })
      .count(),
    1,
  );
  await table.getByRole("button", { name: "درجة العميل", exact: true }).click();
  await rows([records[2]!.id, records[1]!.id, records[0]!.id]);
  await page
    .getByRole("button", { name: "إزالة ترتيب الخيارات", exact: true })
    .click();
  await apply(flag.id, "false");
  await rows([records[0]!.id]);
  await page
    .getByRole("button", { name: "إزالة تصفية الخيار", exact: true })
    .click();
  await apply(choice.id, "premium");
  await rows([records[0]!.id, records[2]!.id]);
  assert.equal(await table.getByText("عميل مميز", { exact: true }).count(), 2);
  await page
    .getByRole("button", { name: "إزالة تصفية الخيار", exact: true })
    .click();
  await page.getByLabel("بحث في الحسابات", { exact: true }).fill("مميز");
  await rows([records[0]!.id, records[2]!.id]);
  console.log(
    "PASS browser: dynamic columns, exact numeric order, boolean/list filters and choice-label search",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await apply(flag.id, "false");
  await rows([records[0]!.id]);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page
    .getByRole("button", { name: "إزالة تصفية الخيار", exact: true })
    .click();
  await page.getByRole("button", { name: "مسح البحث", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page
    .getByRole("link", { name: "الخيارات والصلاحيات", exact: true })
    .first()
    .click();
  await page
    .getByRole("table", { name: "دليل الخيارات", exact: true })
    .getByRole("row")
    .filter({ hasText: "browser.choice" })
    .getByRole("button", { name: "تعديل", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("فعال", { exact: true }).uncheck();
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes(`/configuration/options/${choice.id}`) &&
      response.request().method() === "PATCH",
  );
  await dialog.getByRole("button", { name: "حفظ", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.getByText("تم حفظ تعريف الخيار.", { exact: true }).waitFor();
  await page
    .getByRole("link", { name: "دليل الحسابات", exact: true })
    .first()
    .click();
  await table
    .getByRole("columnheader", { name: "درجة العميل", exact: true })
    .waitFor();
  await table
    .getByRole("columnheader", { name: "فئة العميل", exact: true })
    .waitFor({ state: "detached" });
  await page.goto(
    base +
      `/accounts?optionId=${choice.id}&optionOperator=eq&optionValue=premium`,
  );
  await page
    .getByRole("button", { name: "إزالة تصفية الخيار", exact: true })
    .click();
  await page
    .getByLabel("بحث في الحسابات", { exact: true })
    .fill("سجل الخيارات");
  await rows(records.map((record) => record.id));
  assert(!new URL(page.url()).searchParams.has("optionId"));
  const values = await call<{
    values: { definitionId: number; value: unknown }[];
  }>(config + `/record-options?recordKind=account&recordId=${records[0]!.id}`);
  assert.equal(
    values.values.find((value) => value.definitionId === choice.id)?.value,
    "premium",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS browser: mobile filters fit, archived column disappears and stale filter clears while value is retained",
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
