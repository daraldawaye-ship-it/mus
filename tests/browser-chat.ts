import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { chromium, request, type APIRequestContext, type Browser, type BrowserContext, type Page } from "playwright";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { Company, SessionResponse, User } from "../packages/contracts/src/index.ts";
import type { ChatMessage, ChatPage } from "../packages/contracts/src/chat.ts";
import { CHAT_AVATAR_DATA_URL } from "./chat-avatar-fixture.ts";
import { assertChatAvatarFallback, assertLoadedChatAvatar, composeChatEmoji } from "./chat-browser-controls.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const schema = `chat_browser_${randomUUID().replaceAll("-", "")}`;
const password = "Chat-browser-passphrase-2026";
const evidence = "/tmp/tijara-chat-browser";
await mkdir(evidence, { recursive: true });
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
interface Actor { context: APIRequestContext; session: SessionResponse; }
async function call<T>(actor: Actor, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await actor.context.fetch(`/api${path}`, {
    method,
    headers: { Origin: origin, ...(actor.session.csrf ? { "x-csrf-token": actor.session.csrf } : {}) },
    ...(body === undefined ? {} : { data: body }),
  });
  const result: unknown = await response.json();
  assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`);
  return result as T;
}
async function register(context: BrowserContext, name: string, email: string) {
  const actor: Actor = { context: context.request, session: { user: null, csrf: null } };
  actor.session = await call<SessionResponse>(actor, "/auth/register", "POST", {
    name, displayName: name, email, phone: "", password,
  });
  assert(actor.session.user);
  return { ...actor, user: actor.session.user };
}
async function beginConversation(page: Page, name: string) {
  await page.getByRole("button", { name: "محادثة جديدة", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "محادثة جديدة", exact: true });
  await dialog.getByRole("textbox", { name: "البحث عن مستخدم", exact: true }).fill(name);
  await dialog.getByRole("button", { name: `بدء محادثة مع ${name}`, exact: true }).click();
  await page.getByRole("textbox", { name: "نص الرسالة", exact: true }).waitFor();
}
async function typeAndSend(page: Page, text: string, composed = false) {
  const composer = page.getByRole("textbox", { name: "نص الرسالة", exact: true });
  if (composed) assert.equal(await composer.inputValue(), text); else await composer.fill(text);
  await page.getByRole("button", { name: "إرسال الرسالة", exact: true }).click();
  const message = page.locator("[data-chat-message-id]").filter({ hasText: text });
  await message.waitFor({ state: "visible" });
  assert.equal(await composer.inputValue(), "");
  return message;
}
async function assertFitsMobile(page: Page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Chat must not overflow the mobile viewport horizontally");
  for (const name of ["نص الرسالة", "إرسال الرسالة"]) {
    const control = name === "نص الرسالة"
      ? page.getByRole("textbox", { name, exact: true })
      : page.getByRole("button", { name, exact: true });
    const bounds = await control.boundingBox();
    assert(bounds && bounds.width > 0 && bounds.height >= 38, `${name} remains a usable mobile control`);
    const viewport = page.viewportSize()!;
    assert(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, `${name} stays visible in the viewport`);
  }
}

let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let ownerContext: APIRequestContext | undefined;
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];
try {
  runtime = await createApp({ databaseUrl, schema, appOrigin: origin, production: false, serveStatic: true });
  server = runtime.app.listen(port, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const aliceContext = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" });
  const bobContext = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 }, timezoneId: "UTC" });
  contexts.push(aliceContext, bobContext);
  for (const context of contexts) {
    context.setDefaultTimeout(15_000);
    await context.tracing.start({ screenshots: true, snapshots: true });
    context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
  }
  const alice = await register(aliceContext, "سارة الاختبار", "alice@chat-browser.test");
  const bob = await register(bobContext, "خالد الاختبار", "bob@chat-browser.test");
  const photo = await call<{ fullUrl: string }>(alice, "/media", "POST", { purpose: "avatar", companyId: null, original: CHAT_AVATAR_DATA_URL, thumbnail: CHAT_AVATAR_DATA_URL });
  alice.user = (await call<{ user: User }>(alice, "/profile", "PATCH", {
    name: alice.user.name, displayName: alice.user.displayName, email: alice.user.email, phone: alice.user.phone, image: photo.fullUrl,
  })).user;
  await provisionOwner(runtime.pool, { name: "مالك الاختبار", displayName: "مالك الاختبار", email: "owner@chat-browser.test", password });
  ownerContext = await request.newContext({ baseURL: origin });
  const owner: Actor = { context: ownerContext, session: { user: null, csrf: null } };
  owner.session = await call<SessionResponse>(owner, "/auth/login", "POST", { email: "owner@chat-browser.test", password });
  const company = (await call<{ company: Company }>(owner, "/companies", "POST", { name: "شركة دردشة الاختبار", phone: "", address: "" })).company;
  for (const user of [alice.user, bob.user]) await call(owner, `/companies/${company.id}/employees`, "POST", {
    userId: user.id, name: user.name, phone: "", role: "employee", active: true, permissions: [],
  });
  await call(alice, "/appearance", "PATCH", { scope: "public", mode: "dark", color: "#176b61" });
  await call(alice, "/appearance", "PATCH", { scope: `company:${company.id}`, mode: "light", color: "#7255b7" });
  const alicePage = await aliceContext.newPage(), bobPage = await bobContext.newPage();
  await alicePage.goto("/chat");
  await alicePage.bringToFront();
  await alicePage.getByRole("heading", { name: "دردشة تجارة", exact: true }).waitFor();
  await alicePage.locator('html[data-theme="dark"]').waitFor();
  await beginConversation(alicePage, bob.user.name);
  await assertChatAvatarFallback(alicePage.locator(".chat-thread-heading"));
  const personalText = await composeChatEmoji(alicePage, "نص الرسالة", "رسالة شخصية للتأكد من الاستلام والعرض", true, `${evidence}/emoji-picker-desktop-direct.png`);
  const personalMessage = await typeAndSend(alicePage, personalText, true);
  await assertLoadedChatAvatar(personalMessage, alice.user.id);
  // Fetching messages alone does not acknowledge delivery or reading.
  const received = await call<ChatPage<ChatMessage>>(bob, `/chat/conversations/${alice.user.id}/messages?scope=global`);
  const receivedMessage = received.items.find(message => message.text === personalText);
  assert(receivedMessage && receivedMessage.readAt === null);
  // The recipient's real conversation list renders the incoming preview and
  // acknowledges delivery without claiming that its thread has been opened.
  const deliveryResponse = bobPage.waitForResponse(response => response.url().endsWith(`/chat/conversations/${alice.user.id}/receipt`) &&
    response.status() === 200 && response.request().postDataJSON()?.deliveredMessageIds?.includes(receivedMessage.id));
  await bobPage.goto("/chat");
  await deliveryResponse;
  const aliceConversation = bobPage.getByRole("button", { name: `فتح محادثة ${alice.user.name}`, exact: true });
  await assertLoadedChatAvatar(aliceConversation, alice.user.id);
  await alicePage.bringToFront();
  await personalMessage.getByText("تم الاستلام", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await personalMessage.getByText("تم العرض", { exact: true }).count(), 0);
  await alicePage.screenshot({ path: `${evidence}/desktop-dark-delivered.png`, fullPage: true });
  // Only rendering the incoming message in the recipient's visible thread
  // lets the actual browser send a read acknowledgment.
  await bobPage.bringToFront();
  const readResponse = bobPage.waitForResponse(response => response.url().endsWith(`/chat/conversations/${alice.user.id}/receipt`) &&
    response.status() === 200 && response.request().postDataJSON()?.readMessageIds?.includes(receivedMessage.id));
  await bobPage.getByRole("button", { name: `فتح محادثة ${alice.user.name}`, exact: true }).click();
  await bobPage.locator(`[data-chat-message-id="${receivedMessage.id}"]`).waitFor({ state: "visible" });
  await readResponse;
  await assertLoadedChatAvatar(bobPage.locator(".chat-thread-heading"), alice.user.id);
  await assertLoadedChatAvatar(bobPage.locator(`[data-chat-message-id="${receivedMessage.id}"]`), alice.user.id);
  await alicePage.bringToFront();
  await personalMessage.getByText("تم العرض", { exact: true }).waitFor({ state: "visible" });
  const readback = await call<ChatPage<ChatMessage>>(alice, `/chat/conversations/${bob.user.id}/messages?scope=global`);
  assert(readback.items.find(message => message.id === receivedMessage.id)?.readAt, "Visible receipt matches a persisted server read acknowledgment");
  await alicePage.screenshot({ path: `${evidence}/desktop-dark-read.png`, fullPage: true });
  console.log("PASS real private messages and delivered/read receipts across two authenticated browsers");

  await alicePage.setViewportSize({ width: 390, height: 844 });
  await alicePage.getByRole("button", { name: "العودة إلى المحادثات", exact: true }).click();
  await alicePage.getByRole("button", { name: `فتح محادثة ${bob.user.name}`, exact: true }).click();
  await assertFitsMobile(alicePage);
  await alicePage.screenshot({ path: `${evidence}/mobile-dark-private.png`, fullPage: true });
  await alicePage.goto(`/companies/${company.id}/chat`);
  await alicePage.getByRole("heading", { name: "دردشة الشركة", exact: true }).waitFor();
  await alicePage.locator('html[data-theme="light"]').waitFor();
  assert.equal(await alicePage.getByText(personalText, { exact: true }).count(), 0, "Personal messages must not appear in the company scope");
  await beginConversation(alicePage, bob.user.name);
  const internalText = await composeChatEmoji(alicePage, "نص الرسالة", "رسالة خاصة بالشركة فقط", false, `${evidence}/emoji-picker-mobile-direct.png`);
  await typeAndSend(alicePage, internalText, true);
  await assertFitsMobile(alicePage);
  await alicePage.screenshot({ path: `${evidence}/mobile-light-company.png`, fullPage: true });
  await alicePage.goto("/chat");
  await alicePage.getByRole("heading", { name: "دردشة تجارة", exact: true }).waitFor();
  await alicePage.getByRole("button", { name: `فتح محادثة ${bob.user.name}`, exact: true }).click();
  await alicePage.locator('html[data-theme="dark"]').waitFor();
  await alicePage.locator(`[data-chat-message-id="${receivedMessage.id}"]`).waitFor({ state: "visible" });
  assert.equal(await alicePage.getByText(internalText, { exact: true }).count(), 0, "Company messages must not bleed into personal chat after navigation");
  // A valid scoped photo URL whose image request fails must also fall back.
  await bobPage.route(`**/api/chat/avatars/${alice.user.id}?*`, route => route.fulfill({ status: 404, body: "" }));
  await bobPage.reload();
  await bobPage.getByRole("button", { name: `فتح محادثة ${alice.user.name}`, exact: true }).click();
  await assertChatAvatarFallback(bobPage.locator(".chat-thread-heading"));
  await bobPage.screenshot({ path: `${evidence}/avatar-fallback.png`, fullPage: true });
  assert.deepEqual(pageErrors, []);
  console.log("PASS mobile composer, conversation navigation, isolated company scope and per-scope light/dark theme");
} catch (error) {
  for (const [index, context] of contexts.entries()) for (const [pageIndex, page] of context.pages().entries()) {
    if (!page.isClosed()) await page.screenshot({ path: `${evidence}/failure-${index}-${pageIndex}.png`, fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  for (const [index, context] of contexts.entries()) {
    await context.tracing.stop({ path: `${evidence}/trace-${index}.zip` }).catch(() => {});
    await context.close();
  }
  await ownerContext?.dispose();
  await browser?.close();
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await runtime?.close();
  if (runtime) {
    const cleanup = new Pool({ connectionString: databaseUrl });
    try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  }
}
