import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { chromium, request, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { Company, SessionResponse, User } from "../packages/contracts/src/index.ts";
import type { ChatPage } from "../packages/contracts/src/chat.ts";
import type { ChatGroupDetail, ChatGroupMessage } from "../packages/contracts/src/chat-groups.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `chat_groups_browser_${randomUUID().replaceAll("-", "")}`;
const password = "Chat-groups-browser-passphrase-2026";
const evidence = "/tmp/tijara-chat-groups-browser";
await mkdir(evidence, { recursive: true });
const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address(); assert(address && typeof address !== "string");
    probe.close(() => resolve(address.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
interface Actor { context: APIRequestContext; session: SessionResponse; }
async function call<T>(actor: Actor, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await actor.context.fetch(`/api${path}`, {
    method, headers: { Origin: origin, ...(actor.session.csrf ? { "x-csrf-token": actor.session.csrf } : {}) },
    ...(body === undefined ? {} : { data: body }),
  });
  const result: unknown = await response.json();
  assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`);
  return result as T;
}
async function register(context: BrowserContext, name: string, email: string) {
  const actor: Actor = { context: context.request, session: { user: null, csrf: null } };
  actor.session = await call<SessionResponse>(actor, "/auth/register", "POST", { name, displayName: name, email, phone: "", password });
  assert(actor.session.user); return { ...actor, user: actor.session.user };
}
async function createGroup(page: Page, name: string, members: User[]) {
  await page.getByRole("button", { name: "إنشاء مجموعة", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "إنشاء مجموعة دردشة", exact: true });
  await dialog.getByRole("textbox", { name: "اسم المجموعة", exact: true }).fill(name);
  for (const member of members) await dialog.getByRole("checkbox", { name: member.name, exact: true }).check();
  await dialog.getByRole("button", { name: "إنشاء المجموعة", exact: true }).click();
  await page.getByRole("textbox", { name: "نص رسالة المجموعة", exact: true }).waitFor();
  const id = Number(await page.locator("[data-chat-group-id]").getAttribute("data-chat-group-id")); assert(id > 0);
  return id;
}
async function sendMessage(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "نص رسالة المجموعة", exact: true });
  await composer.fill(text);
  await page.getByRole("button", { name: "إرسال رسالة المجموعة", exact: true }).click();
  const message = page.locator("[data-chat-group-message-id]").filter({ hasText: text });
  await message.waitFor({ state: "visible" }); assert.equal(await composer.inputValue(), "");
  return message;
}
function receiptResponse(page: Page, groupId: number, messageId: number, type: "delivered" | "read") {
  const key = type === "read" ? "readMessageIds" : "deliveredMessageIds";
  return page.waitForResponse(response => response.url().endsWith(`/chat/groups/${groupId}/receipt`) &&
    response.status() === 200 && response.request().postDataJSON()?.[key]?.includes(messageId));
}
async function counts(message: Locator, delivered: number, read: number, recipients: number) {
  const num = (value: number) => value.toLocaleString("ar");
  await message.getByText(`تم الاستلام ${num(delivered)} من ${num(recipients)}`, { exact: true }).waitFor({ state: "visible" });
  await message.getByText(`تم العرض ${num(read)} من ${num(recipients)}`, { exact: true }).waitFor({ state: "visible" });
}
async function assertMobile(page: Page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Group chat fits the mobile viewport horizontally");
  for (const control of [page.getByRole("textbox", { name: "نص رسالة المجموعة", exact: true }), page.getByRole("button", { name: "إرسال رسالة المجموعة", exact: true })]) {
    const box = await control.boundingBox(); const viewport = page.viewportSize()!;
    assert(box && box.height >= 38 && box.x >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, "Group composer controls stay visible and usable on mobile");
  }
}
let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let ownerContext: APIRequestContext | undefined;
const contexts: BrowserContext[] = [];
const errors: string[] = [];
try {
  runtime = await createApp({ databaseUrl, schema, appOrigin: origin, production: false, serveStatic: true });
  server = runtime.app.listen(port, "127.0.0.1"); await once(server, "listening");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (let index = 0; index < 3; index++) {
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" });
    context.setDefaultTimeout(15_000); await context.tracing.start({ screenshots: true, snapshots: true });
    context.on("page", page => page.on("pageerror", error => errors.push(error.message))); contexts.push(context);
  }
  const alice = await register(contexts[0]!, "سارة المجموعات", "alice@chat-groups-browser.test");
  const bob = await register(contexts[1]!, "خالد المجموعات", "bob@chat-groups-browser.test");
  const carol = await register(contexts[2]!, "ليلى المجموعات", "carol@chat-groups-browser.test");
  await provisionOwner(runtime.pool, { name: "مالك الاختبار", displayName: "مالك الاختبار", email: "owner@chat-groups-browser.test", password });
  ownerContext = await request.newContext({ baseURL: origin });
  const owner: Actor = { context: ownerContext, session: { user: null, csrf: null } };
  owner.session = await call<SessionResponse>(owner, "/auth/login", "POST", { email: "owner@chat-groups-browser.test", password });
  const company = (await call<{ company: Company }>(owner, "/companies", "POST", { name: "شركة مجموعات المتصفح", phone: "", address: "" })).company;
  for (const member of [alice.user, bob.user, carol.user]) await call(owner, `/companies/${company.id}/employees`, "POST", { userId: member.id, name: member.name, phone: "", role: "employee", active: true, permissions: [] });
  await call(alice, "/appearance", "PATCH", { scope: "public", mode: "dark", color: "#176b61" });
  await call(alice, "/appearance", "PATCH", { scope: `company:${company.id}`, mode: "light", color: "#7255b7" });
  const alicePage = await contexts[0]!.newPage(), bobPage = await contexts[1]!.newPage(), carolPage = await contexts[2]!.newPage();
  await alicePage.goto("/chat"); await alicePage.bringToFront();
  await alicePage.getByRole("heading", { name: "دردشة تجارة", exact: true }).waitFor();
  await alicePage.locator('html[data-theme="dark"]').waitFor();
  const groupName = "فريق تجارة الاختباري";
  const groupId = await createGroup(alicePage, groupName, [bob.user, carol.user]);
  const text = "رسالة الفريق مع تأكيدات حقيقية لكل عضو";
  const message = await sendMessage(alicePage, text);
  const messageId = Number(await message.getAttribute("data-chat-group-message-id")); assert(messageId > 0);
  await counts(message, 0, 0, 2);
  const bobDelivery = receiptResponse(bobPage, groupId, messageId, "delivered");
  await bobPage.goto("/chat"); await bobDelivery;
  await alicePage.bringToFront(); await counts(message, 1, 0, 2);
  let persisted = (await call<ChatPage<ChatGroupMessage>>(alice, `/chat/groups/${groupId}/messages?scope=global`)).items.find(item => item.id === messageId)!;
  assert.equal(persisted.deliveredAt, null, "One recipient never produces an all-delivered timestamp");
  const carolDelivery = receiptResponse(carolPage, groupId, messageId, "delivered");
  await carolPage.goto("/chat"); await carolDelivery;
  await alicePage.bringToFront(); await counts(message, 2, 0, 2);
  const bobRead = receiptResponse(bobPage, groupId, messageId, "read");
  await bobPage.bringToFront(); await bobPage.getByRole("button", { name: `فتح مجموعة ${groupName}`, exact: true }).click();
  await bobPage.locator(`[data-chat-group-message-id="${messageId}"]`).waitFor({ state: "visible" }); await bobRead;
  await alicePage.bringToFront(); await counts(message, 2, 1, 2);
  persisted = (await call<ChatPage<ChatGroupMessage>>(alice, `/chat/groups/${groupId}/messages?scope=global`)).items.find(item => item.id === messageId)!;
  assert(persisted.deliveredAt); assert.equal(persisted.readAt, null, "One reader never produces an all-viewed timestamp");
  const carolRead = receiptResponse(carolPage, groupId, messageId, "read");
  await carolPage.bringToFront(); await carolPage.getByRole("button", { name: `فتح مجموعة ${groupName}`, exact: true }).click();
  await carolPage.locator(`[data-chat-group-message-id="${messageId}"]`).waitFor({ state: "visible" }); await carolRead;
  await alicePage.bringToFront(); await counts(message, 2, 2, 2);
  persisted = (await call<ChatPage<ChatGroupMessage>>(alice, `/chat/groups/${groupId}/messages?scope=global`)).items.find(item => item.id === messageId)!;
  assert(persisted.deliveredAt && persisted.readAt && persisted.receipts.every(receipt => receipt.readAt));
  await message.getByRole("button", { name: "تفاصيل استلام الرسالة وعرضها", exact: true }).click();
  const receipts = alicePage.getByRole("dialog", { name: "تفاصيل استلام الرسالة وعرضها", exact: true });
  for (const member of [bob.user, carol.user]) {
    const row = receipts.locator(".chat-group-receipt-row").filter({ hasText: member.name });
    await row.getByText(/^تم الاستلام ·/).waitFor(); await row.getByText(/^تم العرض ·/).waitFor();
  }
  await alicePage.screenshot({ path: `${evidence}/desktop-dark-group-receipts.png`, fullPage: true });
  await receipts.getByRole("button", { name: "إغلاق النافذة", exact: true }).click();
  console.log("PASS group creation and real delivered/read acknowledgments from all intended recipients");

  await alicePage.setViewportSize({ width: 390, height: 844 }); await assertMobile(alicePage);
  await alicePage.getByRole("button", { name: "تفاصيل المجموعة", exact: true }).click();
  const details = alicePage.getByRole("dialog", { name: "تفاصيل المجموعة", exact: true });
  const renamed = "فريق تجارة المحدّث";
  await details.getByRole("textbox", { name: "اسم المجموعة", exact: true }).fill(renamed);
  const renameResponse = alicePage.waitForResponse(response => response.url().endsWith(`/chat/groups/${groupId}`) && response.request().method() === "PATCH" && response.status() === 200);
  await details.getByRole("button", { name: "حفظ التغييرات", exact: true }).click(); await renameResponse;
  await details.getByRole("button", { name: "إغلاق", exact: true }).click();
  await alicePage.getByRole("heading", { name: renamed, exact: true }).waitFor();
  await alicePage.screenshot({ path: `${evidence}/mobile-dark-group.png`, fullPage: true });
  await alicePage.goto(`/companies/${company.id}/chat`);
  await alicePage.getByRole("heading", { name: "دردشة الشركة", exact: true }).waitFor(); await alicePage.locator('html[data-theme="light"]').waitFor();
  assert.equal(await alicePage.getByRole("button", { name: `فتح مجموعة ${renamed}`, exact: true }).count(), 0);
  assert.equal(await alicePage.getByText(text, { exact: true }).count(), 0);
  const companyGroupId = await createGroup(alicePage, "فريق الشركة المستقل", [bob.user, carol.user]); assert.notEqual(companyGroupId, groupId);
  const companyText = "رسالة مجموعة الشركة فقط"; await sendMessage(alicePage, companyText); await assertMobile(alicePage);
  await alicePage.screenshot({ path: `${evidence}/mobile-light-company-group.png`, fullPage: true });
  await alicePage.goto("/chat"); await alicePage.locator('html[data-theme="dark"]').waitFor();
  await alicePage.getByRole("button", { name: `فتح مجموعة ${renamed}`, exact: true }).click();
  assert.equal(await alicePage.getByText(companyText, { exact: true }).count(), 0);
  await alicePage.getByRole("button", { name: "تفاصيل المجموعة", exact: true }).click();
  const managerDetails = alicePage.getByRole("dialog", { name: "تفاصيل المجموعة", exact: true });
  await managerDetails.getByRole("combobox", { name: "المدير الجديد", exact: true }).selectOption(String(bob.user.id));
  await managerDetails.getByRole("button", { name: "نقل الإدارة", exact: true }).click();
  const transfer = alicePage.getByRole("dialog", { name: "تأكيد نقل الإدارة", exact: true });
  const transferResponse = alicePage.waitForResponse(response => response.url().endsWith(`/chat/groups/${groupId}`) && response.request().method() === "PATCH" && response.status() === 200);
  await transfer.getByRole("button", { name: "تأكيد نقل الإدارة", exact: true }).click(); await transferResponse;
  await managerDetails.getByRole("button", { name: "مغادرة المجموعة", exact: true }).click();
  const leave = alicePage.getByRole("dialog", { name: "تأكيد مغادرة المجموعة", exact: true });
  const leaveResponse = alicePage.waitForResponse(response => response.url().endsWith(`/chat/groups/${groupId}/leave`) && response.status() === 200);
  await leave.getByRole("button", { name: "تأكيد المغادرة", exact: true }).click(); await leaveResponse;
  await alicePage.getByRole("button", { name: `فتح مجموعة ${renamed}`, exact: true }).waitFor({ state: "hidden" });
  const remaining = await call<ChatGroupDetail>(bob, `/chat/groups/${groupId}?scope=global`);
  assert.equal(remaining.group.managerId, bob.user.id); assert(!remaining.members.some(member => member.id === alice.user.id));
  const forbidden = await alice.context.get(`/api/chat/groups/${groupId}/messages?scope=global`); assert([403, 404].includes(forbidden.status()));
  assert.deepEqual(errors, []);
  console.log("PASS responsive group management, manager transfer and leave, isolated company groups and per-scope theme");
} catch (error) {
  for (const [index, context] of contexts.entries()) for (const [pageIndex, page] of context.pages().entries()) if (!page.isClosed())
    await page.screenshot({ path: `${evidence}/failure-${index}-${pageIndex}.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  for (const [index, context] of contexts.entries()) { await context.tracing.stop({ path: `${evidence}/trace-${index}.zip` }).catch(() => {}); await context.close(); }
  await ownerContext?.dispose(); await browser?.close();
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await runtime?.close();
  if (runtime) { const cleanup = new Pool({ connectionString: databaseUrl }); try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await cleanup.end(); } }
}
