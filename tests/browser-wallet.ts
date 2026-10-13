import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { Pool } from "pg";
import { chromium, request, type APIRequestContext } from "playwright";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  RewardTaskDirectory,
  SessionResponse,
  WalletDirectory,
  WalletPolicyDirectory,
  EmployeeWalletAccount,
  WalletConversionPreview,
  WalletConversionDirectory,
  Account,
  Page,
} from "../packages/contracts/src/index.ts";

// One isolated management-to-employee browser flow; no production data.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = "wallet_browser_" + randomUUID().replaceAll("-", "");
const password = "wallet-browser-test-passphrase";
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
      method +
        " " +
        path +
        ": " +
        response.status() +
        " " +
        JSON.stringify(body),
    );
    if (body && typeof body === "object" && "csrf" in body) csrf = body.csrf;
    return body as T;
  };
}
const ownerCall = apiClient(ownerApi);
const employeeCall = apiClient(employeeApi);
try {
  await provisionOwner(runtime.pool, {
    name: "Wallet owner",
    displayName: "Owner",
    email: "wallet-browser-owner@example.test",
    password,
  });
  await ownerCall("/auth/login", "POST", {
    email: "wallet-browser-owner@example.test",
    password,
  });
  const { company } = await ownerCall<{ company: { id: number } }>(
    "/companies",
    "POST",
    {
      name: "شركة المحفظة التجريبية",
      phone: "",
      address: "",
    },
  );
  const base = "/companies/" + company.id;
  const registration = await employeeCall<SessionResponse>(
    "/auth/register",
    "POST",
    {
      name: "موظف المحفظة",
      displayName: "الموظف",
      email: "wallet-browser-staff@example.test",
      phone: "",
      password,
    },
  );
  assert(registration.user);
  const { employee } = await ownerCall<{ employee: { id: number } }>(
    base + "/employees",
    "POST",
    {
      userId: registration.user.id,
      name: "موظف المحفظة",
      phone: "",
      role: "employee",
      active: true,
      permissions: [],
    },
  );
  const errors: string[] = [];
  const ownerContext = await browser.newContext({
    baseURL: origin,
    storageState: await ownerApi.storageState(),
  });
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(10000);
  ownerPage.on("pageerror", (error) => errors.push(error.message));
  await ownerPage.goto(base + "/wallet");
  await ownerPage
    .getByRole("heading", { name: "النقاط والمحفظة", exact: true })
    .waitFor();
  await ownerPage.locator('[data-wallet-points="0"]').waitFor();
  await ownerPage
    .getByRole("button", { name: "إضافة نقاط", exact: true })
    .click();
  const dialog = ownerPage.getByRole("dialog");
  await dialog
    .getByLabel("الموظف", { exact: true })
    .selectOption(String(employee.id));
  await dialog.getByLabel("عدد النقاط", { exact: true }).fill("٢٠");
  assert.equal(
    await dialog.getByLabel("عدد النقاط", { exact: true }).inputValue(),
    "20",
  );
  await dialog
    .getByLabel("سبب الإضافة", { exact: true })
    .fill("مكافأة المتابعة التجريبية");
  await dialog
    .getByRole("button", { name: "إضافة النقاط", exact: true })
    .click();
  await ownerPage
    .getByText("تمت إضافة النقاط وحفظها في السجل.", { exact: true })
    .waitFor();
  await ownerPage.locator('[data-wallet-points="20"]').waitFor();
  const ledger = await ownerCall<WalletDirectory>(
    "" + base + "/wallet?employeeId=" + employee.id,
  );
  assert.equal(ledger.total, 1);
  assert.equal(ledger.wallet!.points, "20");

  const employeeContext = await browser.newContext({
    baseURL: origin,
    storageState: await employeeApi.storageState(),
    viewport: { width: 390, height: 844 },
  });
  const page = await employeeContext.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/wallet");
  await page
    .getByRole("heading", { name: "النقاط والمحفظة", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: "محفظتي، 20 نقطة", exact: true })
    .waitFor();
  await page.locator('[data-wallet-points="20"]').waitFor();
  await page
    .getByRole("table", { name: "سجل النقاط والمحفظة", exact: true })
    .getByText("مكافأة المتابعة التجريبية", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "إضافة نقاط", exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "عكس المكافأة", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "مهام المكافآت", exact: true })
      .count(),
    0,
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "The wallet must fit a mobile viewport",
  );

  await ownerPage
    .getByRole("button", { name: "عكس المكافأة", exact: true })
    .click();
  await dialog
    .getByLabel("سبب العكس", { exact: true })
    .fill("تصحيح مكافأة الاختبار");
  await dialog
    .getByRole("button", { name: "تأكيد العكس", exact: true })
    .click();
  await ownerPage
    .getByText("تم عكس المكافأة مع الاحتفاظ بسجلها الأصلي.", { exact: true })
    .waitFor();
  await ownerPage.locator('[data-wallet-points="0"]').waitFor();
  assert.equal(
    await ownerPage
      .getByRole("button", { name: "عكس المكافأة", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "تحديث", exact: true }).click();
  await page.locator('[data-wallet-points="0"]').waitFor();
  await page
    .getByRole("link", { name: "محفظتي، 0 نقطة", exact: true })
    .waitFor();
  await page.getByText("تصحيح مكافأة الاختبار", { exact: true }).waitFor();

  await ownerPage.goto(base + "/reward-tasks");
  await ownerPage
    .getByRole("heading", { name: "مهام المكافآت", exact: true })
    .waitFor();
  await ownerPage
    .getByLabel("بحث في المهام", { exact: true })
    .fill("زيارة صفحة");
  await ownerPage
    .getByRole("button", { name: "تعديل الكرت", exact: true })
    .click();
  const taskDialog = ownerPage.getByRole("dialog");
  assert(
    await taskDialog.getByLabel("تفعيل المهمة", { exact: true }).isEnabled(),
  );
  assert.equal(
    await taskDialog.getByLabel("تفعيل المهمة", { exact: true }).isChecked(),
    false,
  );
  await taskDialog
    .getByLabel("قيمة المكافأة بالنقاط", { exact: true })
    .fill("٧");
  await taskDialog
    .getByLabel("قاعدة الاستحقاق", { exact: true })
    .selectOption("rolling-seven-days");
  await taskDialog
    .getByLabel("الصفحة المرتبطة", { exact: true })
    .selectOption("company.wallet");
  await taskDialog.getByLabel("تفعيل المهمة", { exact: true }).check();
  await taskDialog
    .getByRole("button", { name: "حفظ الكرت", exact: true })
    .click();
  await ownerPage
    .getByText("تم حفظ إعدادات كرت المهمة.", { exact: true })
    .waitFor();
  const saved = (
    await ownerCall<RewardTaskDirectory>(base + "/reward-tasks")
  ).tasks.find((task) => task.code === "PAGE_VISIT")!;
  assert.equal(saved.points, "7");
  assert.equal(saved.repeatRule, "rolling-seven-days");
  assert.equal(saved.pageKey, "company.wallet");
  assert.equal(saved.enabled, true);

  // Make the initial wallet read finish before its page-visit reward. The UI
  // must refresh both the ledger and header after the later committed event.
  const walletResponse = (response: import("playwright").Response) =>
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === "/api" + base + "/wallet" &&
    response.ok();
  let visitRequests = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname ===
      "/api" + base + "/reward-events/page-visit"
    )
      visitRequests++;
  });
  const initialWallet = page.waitForResponse(walletResponse);
  const visitRoute = "**/api" + base + "/reward-events/page-visit";
  await page.route(visitRoute, async (route) => {
    await initialWallet;
    await route.continue();
  });
  await page.reload();
  await page.locator('[data-wallet-points="7"]').waitFor();
  await page
    .getByRole("link", { name: "محفظتي، 7 نقطة", exact: true })
    .waitFor();
  await page
    .getByRole("table", { name: "سجل النقاط والمحفظة", exact: true })
    .getByText("مكافأة زيارة صفحة", { exact: true })
    .waitFor();
  assert.equal(visitRequests, 1);
  const refreshedWallet = page.waitForResponse(walletResponse);
  await page.getByRole("button", { name: "تحديث", exact: true }).click();
  await refreshedWallet;
  assert.equal(
    visitRequests,
    1,
    "Refreshing wallet data is not another page visit",
  );
  await page.unroute(visitRoute);

  await ownerPage
    .getByLabel("بحث في المهام", { exact: true })
    .fill("DAILY_LOGIN");
  await ownerPage
    .getByRole("button", { name: "تعديل الكرت", exact: true })
    .click();
  assert(
    await taskDialog.getByLabel("تفعيل المهمة", { exact: true }).isEnabled(),
  );
  assert(
    await taskDialog
      .getByLabel("قاعدة الاستحقاق", { exact: true })
      .isDisabled(),
  );
  assert.equal(
    await taskDialog
      .getByLabel("قاعدة الاستحقاق", { exact: true })
      .inputValue(),
    "daily",
  );
  await taskDialog
    .getByLabel("قيمة المكافأة بالنقاط", { exact: true })
    .fill("٥٠");
  await taskDialog.getByLabel("تفعيل المهمة", { exact: true }).check();
  await taskDialog
    .getByRole("button", { name: "حفظ الكرت", exact: true })
    .click();
  await taskDialog.waitFor({ state: "hidden" });
  const loginTask = (
    await ownerCall<RewardTaskDirectory>(base + "/reward-tasks")
  ).tasks.find((task) => task.code === "DAILY_LOGIN")!;
  assert.equal(loginTask.enabled, true);
  assert.equal(loginTask.points, "50");
  assert.equal(loginTask.repeatRule, "daily");

  await page.goto("/profile");
  await page
    .getByRole("heading", { name: "حسابي العام", exact: true })
    .waitFor();
  assert.equal(
    (await employeeCall<WalletDirectory>(base + "/wallet")).wallet!.points,
    "7",
    "Opening a public page alone must not grant a company entry reward",
  );
  const beforeEntry = page.waitForResponse(walletResponse);
  const activateRoute = "**/api" + base + "/activate";
  await page.route(activateRoute, async (route) => {
    await beforeEntry;
    await route.continue();
  });
  await page.goto(base + "/wallet");
  await page.locator('[data-wallet-points="57"]').waitFor();
  await page
    .getByRole("link", { name: "محفظتي، 57 نقطة", exact: true })
    .waitFor();
  await page
    .getByRole("table", { name: "سجل النقاط والمحفظة", exact: true })
    .getByText("مكافأة دخول الشركة", { exact: true })
    .waitFor();
  await page.unroute(activateRoute);
  await page.reload();
  await page.locator('[data-wallet-points="57"]').waitFor();
  const finalLedger = await employeeCall<WalletDirectory>(base + "/wallet");
  assert.equal(finalLedger.total, 4);
  assert.equal(finalLedger.wallet!.points, "57");

  // Configure a declared rate and employee account through the real controls.
  // Preview must leave both the ledger and the available points unchanged.
  const settings = await ownerCall<WalletPolicyDirectory>(
    base + "/wallet-settings",
  );
  assert(settings.baseCurrency && settings.baseCurrency.active);
  assert.equal(settings.policy.pointValue, null);
  const expenseAccounts = await ownerCall<Page<Account>>(
    base + "/accounts?kind=posting&category=expense&active=true&pageSize=100",
  );
  const postingAccounts = await ownerCall<Page<Account>>(
    base + "/accounts?kind=posting&active=true&pageSize=100",
  );
  const expenseAccount = expenseAccounts.items[0];
  const employeeAccount = postingAccounts.items.find(
    (account) => account.id !== expenseAccount?.id,
  );
  assert(expenseAccount && employeeAccount);
  await ownerPage.goto(base + "/wallet");
  await ownerPage
    .getByRole("link", { name: "إعدادات المحفظة", exact: true })
    .click();
  await ownerPage
    .getByRole("heading", { name: "إعدادات المحفظة", exact: true })
    .waitFor();
  await ownerPage
    .getByLabel("قيمة النقطة الواحدة", { exact: true })
    .fill("٠٫١٢٥");
  await ownerPage
    .getByLabel("عملة التحويل", { exact: true })
    .selectOption(String(settings.baseCurrency.id));
  await ownerPage
    .getByLabel("بحث عن حساب مصروف مكافآت النقاط", { exact: true })
    .fill(expenseAccount.code);
  await ownerPage
    .getByLabel("حساب مصروف مكافآت النقاط", { exact: true })
    .selectOption(String(expenseAccount.id));
  await ownerPage
    .getByLabel("طريقة اعتماد التحويل", { exact: true })
    .selectOption("approval");
  await ownerPage
    .getByRole("button", { name: "حفظ إعدادات التحويل", exact: true })
    .click();
  await ownerPage
    .getByText(
      "تم حفظ إعدادات التحويل. يمكن مراجعة نتيجتها من معاينة المحفظة.",
      {
        exact: true,
      },
    )
    .waitFor();
  await ownerPage
    .getByLabel("الموظف", { exact: true })
    .selectOption(String(employee.id));
  await ownerPage
    .getByLabel("بحث عن حساب الموظف المرتبط بالمحفظة", { exact: true })
    .fill(employeeAccount.code);
  await ownerPage
    .getByLabel("حساب الموظف المرتبط بالمحفظة", { exact: true })
    .selectOption(String(employeeAccount.id));
  await ownerPage
    .getByRole("button", { name: "حفظ حساب الموظف", exact: true })
    .click();
  await ownerPage
    .getByText("تم حفظ ربط حساب الموظف.", { exact: true })
    .waitFor();
  const savedPolicy = (
    await ownerCall<WalletPolicyDirectory>(base + "/wallet-settings")
  ).policy;
  assert.equal(savedPolicy.pointValue, "0.125");
  assert.equal(savedPolicy.currencyId, settings.baseCurrency.id);
  assert.equal(savedPolicy.expenseAccountId, expenseAccount.id);
  assert.equal(savedPolicy.approvalMode, "approval");
  const savedBinding = await ownerCall<{ binding: EmployeeWalletAccount }>(
    base + "/wallet-settings/employee-accounts/" + employee.id,
  );
  assert.equal(savedBinding.binding.accountId, employeeAccount.id);

  await page
    .getByRole("button", { name: "معاينة تحويل النقاط", exact: true })
    .click();
  const previewDialog = page.getByRole("dialog");
  await previewDialog
    .getByLabel("مبلغ التحويل المتوقع", { exact: true })
    .waitFor();
  assert.equal(
    await previewDialog
      .getByLabel("مبلغ التحويل المتوقع", { exact: true })
      .inputValue(),
    "7.13 YER",
  );
  assert.equal(
    await previewDialog.getByLabel("حساب الموظف", { exact: true }).inputValue(),
    employeeAccount.code + " — " + employeeAccount.name,
  );
  const preview = await employeeCall<{ preview: WalletConversionPreview }>(
    base + "/wallet/conversion-preview?employeeId=" + employee.id,
  );
  assert.equal(preview.preview.canConvert, true);
  assert.equal(preview.preview.configurationComplete, true);
  assert.equal(preview.preview.amount, "7.13");
  const afterPreview = await employeeCall<WalletDirectory>(base + "/wallet");
  assert.equal(afterPreview.total, 4);
  assert.equal(afterPreview.wallet!.points, "57");
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "The conversion preview fits the mobile viewport",
  );
  let conversionRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api" + base + "/wallet-conversions"
    )
      conversionRequests++;
  });
  await previewDialog
    .getByRole("button", { name: "إرسال طلب الاعتماد", exact: true })
    .dblclick();
  await previewDialog
    .getByText("أُرسل طلب التحويل وحُجزت نقاطه حتى قرار الإدارة.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    conversionRequests,
    1,
    "Double clicking sends one immutable request",
  );
  await previewDialog
    .getByRole("button", { name: "إغلاق", exact: true })
    .click();
  await page.locator('[data-wallet-points="0"]').waitFor();
  await page
    .getByRole("link", { name: "محفظتي، 0 نقطة", exact: true })
    .waitFor();
  await page.getByText("محجوزة لطلبات الاعتماد:", { exact: false }).waitFor();
  const reservedWallet = await employeeCall<WalletDirectory>(base + "/wallet");
  assert.equal(reservedWallet.wallet!.points, "0");
  assert.equal(reservedWallet.wallet!.totalPoints, "57");
  assert.equal(reservedWallet.wallet!.reservedPoints, "57");
  assert.equal(
    reservedWallet.total,
    4,
    "Pending requests reserve points without consuming history",
  );
  await page.getByRole("link", { name: "تحويلات النقاط", exact: true }).click();
  await page
    .getByRole("heading", { name: "تحويلات النقاط", exact: true })
    .waitFor();
  const conversionTable = page.getByRole("table", {
    name: "سجل تحويلات النقاط",
    exact: true,
  });
  await conversionTable
    .getByText("بانتظار الاعتماد", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "عرض ومتابعة", exact: true }).click();
  const requestDialog = page.getByRole("dialog");
  assert.equal(
    await requestDialog
      .getByRole("button", { name: "اعتماد التحويل", exact: true })
      .count(),
    0,
  );
  await requestDialog
    .getByRole("button", { name: "إلغاء طلبي", exact: true })
    .waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Employee conversion history fits the mobile viewport",
  );
  await requestDialog
    .getByRole("button", { name: "إغلاق", exact: true })
    .click();

  await ownerPage.goto(base + "/wallet");
  await ownerPage
    .getByRole("link", { name: "تحويلات النقاط", exact: true })
    .click();
  await ownerPage
    .getByRole("heading", { name: "تحويلات النقاط", exact: true })
    .waitFor();
  await ownerPage
    .getByRole("button", { name: "عرض ومتابعة", exact: true })
    .click();
  const approvalDialog = ownerPage.getByRole("dialog");
  assert.equal(
    await approvalDialog.getByLabel("المبلغ", { exact: true }).inputValue(),
    "7.13 YER",
  );
  await approvalDialog
    .getByRole("button", { name: "اعتماد التحويل", exact: true })
    .click();
  await approvalDialog
    .getByLabel("سبب القرار", { exact: true })
    .fill("اعتماد مكافأة الموظف التجريبية");
  await approvalDialog
    .locator("form")
    .getByRole("button", { name: "اعتماد التحويل", exact: true })
    .dblclick();
  await ownerPage
    .getByText("تم اعتماد التحويل وترحيل المبلغ إلى حساب الموظف.", {
      exact: true,
    })
    .waitFor();
  await approvalDialog.getByRole("link", { name: /^فتح القيد / }).waitFor();
  const posted = await ownerCall<WalletConversionDirectory>(
    base + "/wallet-conversions",
  );
  assert.equal(posted.total, 1);
  assert.equal(posted.items[0]!.status, "posted");
  assert.equal(posted.items[0]!.amount, "7.13");
  assert(posted.items[0]!.financialDocumentId);
  const journal = (
    await runtime.pool.query(
      `SELECT account_id,debit::text,credit::text FROM financial_document_lines
     WHERE company_id=$1 AND document_id=$2 ORDER BY line_number`,
      [company.id, posted.items[0]!.financialDocumentId],
    )
  ).rows;
  assert.deepEqual(journal, [
    { account_id: expenseAccount.id, debit: "7.130000", credit: "0.000000" },
    { account_id: employeeAccount.id, debit: "0.000000", credit: "7.130000" },
  ]);
  await approvalDialog
    .getByRole("button", { name: "إغلاق", exact: true })
    .click();
  await ownerPage
    .getByRole("table", { name: "سجل تحويلات النقاط", exact: true })
    .getByText("مُرحّل إلى الحساب", { exact: true })
    .waitFor();
  await page.goto(base + "/wallet");
  await page.locator('[data-wallet-points="0"]').waitFor();
  await page
    .getByRole("link", { name: "محفظتي، 0 نقطة", exact: true })
    .waitFor();
  await page
    .getByRole("table", { name: "سجل النقاط والمحفظة", exact: true })
    .getByText("تحويل النقاط إلى الحساب", { exact: true })
    .waitFor();
  const convertedWallet = await employeeCall<WalletDirectory>(base + "/wallet");
  assert.equal(convertedWallet.total, 5);
  assert.equal(convertedWallet.wallet!.totalPoints, "0");
  assert.equal(convertedWallet.wallet!.reservedPoints, "0");
  assert.equal(
    convertedWallet.items.filter((item) => item.kind === "conversion").length,
    1,
  );
  assert.equal(
    convertedWallet.items.find((item) => item.kind === "conversion")!.points,
    "-57",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: wallet rewards, exact conversion preview, mobile reservation and manager approval with one balanced journal and preserved ledger",
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
    await cleanup.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
  } finally {
    await cleanup.end();
  }
}
