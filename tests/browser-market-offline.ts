import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import express from "express";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "playwright";
import { marketTypes, type MarketCard, type MarketMeta } from "../packages/contracts/src/medicine-market.ts";
import { marketNotModified, sendMarketRead } from "../apps/api/src/market/conditional-read.ts";

// Runs the real market UI, API client, IndexedDB caches and service worker against
// a disposable local server. No connection, write or invoice reaches production.
const root = resolve("apps/web");
const output = await mkdtemp(resolve(tmpdir(), "alraesy-market-offline-"));
const htmlFile = resolve(root, "market-offline-browser-test.html");
const entryFile = resolve(root, "market-offline-browser-test.tsx");
const fixture = `import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {SessionProvider,useSession,api} from './src/api';
import {getMarketCacheScope,getMarketReadStatus} from './src/market-offline';
import {returnToOnline} from './src/connection-mode';
import {prepareInstall} from './src/app-install';
import {MedicineMarketPage} from './src/pages/MedicineMarketPage';
import './src/styles.css';
prepareInstall();
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function Fixture(){
 const session=useSession();
 useEffect(()=>{window.marketOfflineTest={api,scope:getMarketCacheScope,status:getMarketReadStatus,
  reloadSession:session.reloadSession,logout:session.logout,returnToOnline,
  invalidate:()=>client.invalidateQueries({queryKey:['medicine-market']})};});
 if(session.loading)return <p>جارٍ بدء الاختبار المحلي…</p>;
 const command=async(action)=>{await fetch('/_offline_test/'+action,{method:'POST'});
  if(action==='disconnect'){location.reload();return;}
  if(action==='owner')await session.reloadSession();
  if(action==='reconnect')await returnToOnline();
  await client.invalidateQueries({queryKey:['medicine-market']});};
 return <><details style={{padding:'8px'}}><summary>أدوات الاختبار المحلي</summary>
  <button onClick={()=>command('price')}>تغيير سعر الاختبار</button>
  <button onClick={()=>command('disconnect')}>قطع الاتصال وإعادة الفتح</button>
  <button onClick={()=>command('reconnect')}>إعادة اتصال الاختبار</button>
  <button onClick={()=>command('owner')}>دخول مالك الاختبار</button>
  <button onClick={()=>session.logout()}>خروج حساب الاختبار</button>
  <button onClick={()=>command('deny')}>حجب قراءة الاختبار</button>
 </details><MedicineMarketPage/></>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><BrowserRouter><SessionProvider><Fixture/></SessionProvider></BrowserRouter></QueryClientProvider>);
`;
await writeFile(entryFile, fixture);
await writeFile(htmlFile, '<!doctype html><html lang="ar" dir="rtl"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/market-offline-browser-test.tsx"></script></body></html>');

const now = "2026-11-19T00:00:00.000Z";
function card(id: number, kind: MarketCard["kind"], name: string, data: Record<string, unknown> = {}): MarketCard {
  return { id, kind, name, data, status: "published", archived: false, revision: 1,
    createdAt: now, updatedAt: now, likes: 0, ratingCount: 0, ratingAverage: null,
    myLiked: false, myRating: null, createdBy: 1,
    statistics: { opens: 0, comments: 0, ratingCount: 0, ratingAverage: null, relations: {} } };
}
const image = "/api/medicine-market/images/11111111-1111-4111-8111-111111111111";
const cards = [card(901, "agent", "وكيل الأوفلاين"), card(902, "composition", "تركيب الأوفلاين"),
  ...Array.from({ length: 45 }, (_, i) => card(101 + i, "medicine", `دواء الأوفلاين ${i + 1}`, {
    englishName: `Offline medicine ${i + 1}`, purchasePrice: "125", defaultSalePrice: "150",
    image, agentId: 901, compositionId: 902,
  }))];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2k0AAAAASUVORK5CYII=", "base64");
const owner = { id: 71, name: "اختبار", displayName: "مالك محلي", email: "offline@example.test",
  kind: "admin", owner: true, archived: false, suspended: false, editor: true, monitor: true };
let currentUser: typeof owner | null = null;
let denyMarket = false;
let delayCards = 0;
const responses: { path: string; status: number; conditional: boolean }[] = [];
const app = express();
let disconnected = false;
app.use((req, _res, next) => {
  if (disconnected && req.path !== '/_offline_test/reconnect') { req.socket.destroy(); return; }
  next();
});
app.use(express.json());
app.post('/_offline_test/:command', (req, res) => {
  if(req.params.command === 'price') cards.find(c => c.id === 145)!.data.defaultSalePrice = '275';
  if(req.params.command === 'owner') currentUser = owner;
  if(req.params.command === 'deny') denyMarket = true;
  if(req.params.command === 'reconnect') { disconnected = false; denyMarket = false; }
  res.json({ ok: true });
  if(req.params.command === 'disconnect') disconnected = true;
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/auth/session", (_req, res) => res.json({ user: currentUser, csrf: currentUser ? "test-csrf" : null }));
app.post("/api/auth/logout", (_req, res) => { currentUser = null; res.json({ ok: true }); });
app.use("/api/medicine-market", async (req, res) => {
  if (denyMarket) { res.status(403).json({ error: { code: "forbidden", message: "السوق غير متاح لهذا الحساب" } }); return; }
  res.set("Cache-Control", "private, no-cache");
  res.once("finish", () => responses.push({ path: req.url, status: res.statusCode, conditional: !!req.get("If-None-Match") }));
  if (req.method !== "GET") { res.json({ ok: true, opens: 1 }); return; }
  if (/^\/images\/|\/image-variants\//.test(req.path)) {
    if (!marketNotModified(req, res, png)) res.type("image/png").send(png);
    return;
  }
  const json = (value: unknown) => sendMarketRead(req, res, value);
  if (req.path === "/meta") {
    const meta: MarketMeta = {
      types: marketTypes.filter(t => ["medicine", "agent", "composition"].includes(t.key)).map(t => ({ ...t,
        fields: t.fields.filter(f => f.visibility === "public" || currentUser?.owner).map(f => ({ ...f, points: { add: 0, edit: 0 }, policyRevision: 1 })) })),
      permissions: { canContribute: !!currentUser, canConfigure: false, canModerate: false,
        canArchive: false, canSeeAccounting: !!currentUser, canSeeMinistry: !!currentUser },
      references: [], userPoints: "0",
    };
    json(meta); return;
  }
  const visible = (item: MarketCard) => ({ ...item, data: { ...item.data,
    ...(currentUser ? { accountingMappings: [{ system: "بيانات المالك الخاصة", identifier: "private-owner-only" }] } : {}) } });
  if (req.path === "/cards") {
    if (delayCards) await new Promise(resolve => setTimeout(resolve, delayCards));
    const kind = String(req.query.kind ?? "");
    const q = String(req.query.q ?? "").toLowerCase();
    const page = Number(req.query.page) || 1, pageSize = Number(req.query.pageSize) || 20;
    const items = cards.filter(c => (!kind || c.kind === kind) && (!q || `${c.id} ${c.name} ${c.data.englishName ?? ""}`.toLowerCase().includes(q)))
      .sort((a, b) => b.id - a.id);
    json({ items: items.slice((page - 1) * pageSize, page * pageSize).map(visible), total: items.length, page, pageSize }); return;
  }
  const related = /^\/cards\/(\d+)\/related-medicines$/.exec(req.path);
  if (related) {
    const cursor = Number(req.query.cursor) || Number.MAX_SAFE_INTEGER;
    const items = cards.filter(c => c.kind === "medicine" && c.id < cursor).sort((a, b) => b.id - a.id);
    const slice = items.slice(0, 20);
    json({ items: slice.map(c => ({ ...visible(c), englishName: String(c.data.englishName) })), nextCursor: items.length > 20 ? slice.at(-1)!.id : null }); return;
  }
  const detail = /^\/cards\/(\d+)$/.exec(req.path);
  if (detail) {
    const item = cards.find(c => c.id === Number(detail[1]));
    if (!item) { res.status(404).json({ error: { message: "الكرت غير موجود", code: "missing" } }); return; }
    json({ card: visible(item), comments: [], contributions: [] }); return;
  }
  res.status(404).json({ error: { code: "missing", message: "مسار غير موجود في الاختبار" } });
});
app.use("/api", (_req, res) => res.json({ items: [], total: 0, page: 1, pageSize: 20 }));

let server: ReturnType<typeof app.listen> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let testPage: Page | undefined;
async function api(page: Page, path: string, fresh = false) {
  return page.evaluate(async ({ path, fresh }) => (window as any).marketOfflineTest.api(path, { marketFresh: fresh }), { path, fresh });
}
async function cacheReady(page: Page, path: string) {
  await page.waitForFunction(path => !!(window as any).marketOfflineTest?.status(path)?.savedAt, path);
}
try {
  await build({ configFile: false, root, plugins: [react()], publicDir: false,
    logLevel: "error", build: { outDir: output, emptyOutDir: true,
      rollupOptions: { input: htmlFile } } });
  const html = await readFile(resolve(output, "market-offline-browser-test.html"), "utf8");
  const assets = (await readdir(resolve(output, "assets"))).filter(f => /\.(js|css)$/.test(f)).map(f => "/assets/" + f);
  // The real worker additionally insists on the two operational route chunks;
  // these harmless fixture chunks allow exercising its atomic shell publication.
  assets.push("/assets/CommercePages-fixture.js", "/assets/FinancePages-fixture.js");
  app.get(["/assets/CommercePages-fixture.js", "/assets/FinancePages-fixture.js"], (_req, res) => res.type("application/javascript").send("/* test shell route */"));
  app.get("/offline-core-assets.json", (_req, res) => res.json({ required: assets, optional: [] }));
  app.get("/offline-assets.json", (_req, res) => res.json(assets));
  app.get("/push-sw.js", (_req, res) => res.type("application/javascript").sendFile(resolve(root, "public/push-sw.js")));
  app.get(["/site-icon.png", "/site-icon-512.png"], (_req, res) => res.type("image/png").send(png));
  app.get("/site.webmanifest", (_req, res) => res.type("application/manifest+json").send('{}'));
  app.use(express.static(output));
  app.get("/{*path}", (_req, res) => res.type("text/html").send(html));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  if (process.env.MARKET_OFFLINE_SERVE_ONLY === '1') {
    console.log(`MARKET_OFFLINE_TEST_SERVER ${origin}`);
    await new Promise<void>(() => {});
  }
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  testPage = page;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/?kind=medicine`);
  await page.getByRole("button", { name: "فتح الكرت: دواء الأوفلاين 45", exact: true }).waitFor();
  const listPath = "/medicine-market/cards?kind=medicine&q=&page=1&pageSize=18&archived=false&sort=updated";
  await cacheReady(page, listPath);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole("button", { name: "فتح الكرت: دواء الأوفلاين 45", exact: true }).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".market-card-photo-icon img")).some(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0));
  console.log("PASS initial catalogue and image preparation");

  // A cold navigation reads saved cards before a slow background refresh finishes.
  cards.find(c => c.id === 145)!.data.defaultSalePrice = "275";
  delayCards = 1800;
  const start = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  const first = page.getByRole("button", { name: "فتح الكرت: دواء الأوفلاين 45", exact: true });
  await first.waitFor();
  assert(Date.now() - start < 1600, "Saved catalogue should appear before the delayed response");
  await page.waitForFunction(() => document.querySelector(".market-compact-card-price")?.textContent?.includes("275"));
  delayCards = 0;
  await api(page, listPath, true);
  assert(responses.some(r => r.path.startsWith("/cards?") && r.status === 304 && r.conditional), "Unchanged JSON must use conditional 304 validation");
  console.log("PASS immediate cached display, background refresh and conditional 304");

  // Download two relation batches, leaving the third deliberately unvisited.
  await page.goto(`${origin}/?card=901`);
  await page.locator(".medicine-market-detail-heading").waitFor();
  await page.locator(".market-related-medicines .market-compact-card").first().waitFor();
  await page.locator(".market-related-medicines .market-catalog-section-footer button").click();
  await page.waitForFunction(() => document.querySelectorAll(".market-related-medicines .market-compact-card").length >= 40);
  await cacheReady(page, "/medicine-market/cards/901/related-medicines?cursor=126");
  console.log("PASS related medicine batches saved independently");

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".medicine-market-detail-heading").waitFor();
  await page.locator(".market-related-medicines .market-compact-card").first().waitFor();
  await page.locator(".market-related-medicines .market-catalog-section-footer button").click();
  await page.waitForFunction(() => document.querySelectorAll(".market-related-medicines .market-compact-card").length >= 40);
  assert.match(await page.locator("body").innerText(), /المحفوظ|محفوظ|دون إنترنت/);
  const savedCard = page.getByRole("button", { name: "فتح الكرت: دواء الأوفلاين 45", exact: true });
  await savedCard.click();
  await page.locator(".medicine-market-detail-heading").waitFor();
  assert.match(await page.locator("body").innerText(), /دواء الأوفلاين 45/);
  assert.match(await page.locator("body").innerText(), /جزئي|التفاصيل|المحمّل|المحمل/);
  // Local search may produce only the subset downloaded on this device.
  const search = await api(page, "/medicine-market/cards?kind=medicine&q=Offline%20medicine%2045&page=1&pageSize=18");
  assert((search as { items: MarketCard[] }).items.some(c => c.id === 145));
  await assert.rejects(api(page, "/medicine-market/cards/987654"));
  await assert.rejects(api(page, "/medicine-market/contributions?mine=true"));
  console.log("PASS real offline shell reload, relation pages, card-from-list and local search");

  await mkdir(resolve('artifacts'), { recursive: true });
  await page.screenshot({ path: resolve('artifacts', "market-offline-phone.png"), fullPage: true });
  const geometry = await page.evaluate(() => ({ inner: innerWidth, width: document.documentElement.scrollWidth }));
  assert(geometry.width <= geometry.inner + 1, JSON.stringify(geometry));
  await context.setOffline(false);
  await page.evaluate(() => (window as any).marketOfflineTest.returnToOnline());
  currentUser = owner;
  await page.evaluate(() => (window as any).marketOfflineTest.reloadSession());
  const privateDetail = await api(page, "/medicine-market/cards/145", true) as { card: MarketCard };
  assert.equal((privateDetail.card.data.accountingMappings as { identifier: string }[])[0]!.identifier, "private-owner-only");
  const oldScope = await page.evaluate(() => (window as any).marketOfflineTest.scope());
  await page.evaluate(() => (window as any).marketOfflineTest.logout());
  assert.notEqual(await page.evaluate(() => (window as any).marketOfflineTest.scope()), oldScope);
  const publicDetail = await api(page, "/medicine-market/cards/145", true) as { card: MarketCard };
  assert.equal(publicDetail.card.data.accountingMappings, undefined);
  console.log("PASS private account separation and logout isolation");

  denyMarket = true;
  await assert.rejects(api(page, "/medicine-market/cards/145", true));
  await context.setOffline(true);
  await assert.rejects(api(page, "/medicine-market/cards/145"), "Permission rejection must revoke the saved card");
  console.log("PASS explicit permission rejection never falls back to old data");
  assert.deepEqual(errors, [], errors.join("\n"));
  console.log("MARKET_OFFLINE_BROWSER_OK");
} catch (error) {
  if (testPage && !testPage.isClosed()) {
    await mkdir(resolve('artifacts'), { recursive: true });
    await testPage.screenshot({ path: resolve('artifacts', 'market-offline-failure.png'), fullPage: true }).catch(() => {});
    console.error((await testPage.locator('body').innerText().catch(() => '')).slice(0, 5000));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await Promise.all([rm(htmlFile, { force: true }), rm(entryFile, { force: true })]);
  await rm(output, { recursive: true, force: true });
}
