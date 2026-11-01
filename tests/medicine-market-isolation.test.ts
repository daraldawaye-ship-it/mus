import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import express, { type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { createMarketApp } from "../apps/api/src/market/app.ts";
import { createMarketGateway, marketGatewayOptions } from "../apps/api/src/market/gateway.ts";
import { marketVerifier, signMarketRequest } from "../apps/api/src/market/transport.ts";
import { transferMarket } from "../apps/api/src/market/transfer.ts";
import { medicineMarketRoutes } from "../apps/api/src/routes-medicine-market.ts";
import { apiCatalog, dispatchApi } from "../apps/api/src/services/mcp-api.ts";
import { HttpError } from "../apps/api/src/errors.ts";

const secret = "isolated-market-test-secret-at-least-32-bytes";
const owner: User = { id: 1, name: "Owner", displayName: "Owner", email: "", phone: "", image: "", kind: "admin", owner: true, archived: false, suspended: false, editor: false, monitor: false, createdAt: new Date().toISOString() };
const member: User = { ...owner, id: 2, name: "Member", displayName: "Member", kind: "member", owner: false };
// PGlite executes real PostgreSQL SQL in independent WASM databases; the adapter serializes pg clients.
function adapter(db: PGlite) {
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous; return release;
  };
  const query = async (sql: string, args?: unknown[]) => {
    const result = await db.query(sql, args);
    return { rows: result.rows, rowCount: result.affectedRows || result.rows.length };
  };
  return {
    async query(sql: string, args?: unknown[]) { const release = await acquire(); try { return await query(sql, args); } finally { release(); } },
    async connect() { const release = await acquire(); return { query, release }; },
  } as unknown as Pool;
}
async function serve(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const errors: ErrorRequestHandler = (err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: { code: err.code ?? "internal", message: err.message } });
async function request(url: string, method: string, path: string, user = "", body?: unknown) {
  const r = await fetch(url + path, { method, headers: { "content-type": "application/json", "x-test-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() as any };
}

test("signed market transport rejects forged, altered, replayed and expired authority", () => {
  const path = "/api/medicine-market/cards", body = '{"name":"safe"}';
  const signed = signMarketRequest(secret, "POST", path, owner, [], body);
  const verify = marketVerifier(secret);
  assert.throws(() => verify("POST", path, signed["x-market-context"], "0".repeat(64), body));
  assert.throws(() => verify("POST", path, signed["x-market-context"], signed["x-market-signature"], body + " "));
  assert.throws(() => verify("POST", path + "?other=1", signed["x-market-context"], signed["x-market-signature"], body));
  assert.equal(verify("POST", path, signed["x-market-context"], signed["x-market-signature"], body).user?.id, 1);
  assert.throws(() => verify("POST", path, signed["x-market-context"], signed["x-market-signature"], body));
  const now = Date.now;
  try { Date.now = () => now() + 60000; assert.throws(() => marketVerifier(secret)("POST", path, signed["x-market-context"], signed["x-market-signature"], body)); }
  finally { Date.now = now; }
});

test("dedicated database preserves data and policies; outages never fall back to primary market tables", async t => {
  const core = new PGlite(), market = new PGlite();
  t.after(async () => { await core.close(); await market.close(); });
  await core.exec(`CREATE TABLE users(id integer PRIMARY KEY, display_name text NOT NULL, name text DEFAULT '', email text DEFAULT '', phone text DEFAULT '', image text DEFAULT '', kind text DEFAULT 'member', owner boolean DEFAULT false, archived boolean DEFAULT false, suspended boolean DEFAULT false, editor boolean DEFAULT false, monitor boolean DEFAULT false, created_at timestamptz DEFAULT now());
    INSERT INTO users(id,display_name,kind,owner) VALUES(1,'Owner','admin',true),(2,'Member','member',false);
    CREATE TABLE page_registry(key text PRIMARY KEY);
    CREATE TABLE page_settings(page_key text, company_id integer, enabled boolean);
    CREATE TABLE audit_events(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id integer,actor_name text,scope text,company_id integer,action text,target_type text,target_id integer,before_value jsonb,after_value jsonb,created_at timestamptz DEFAULT now());`);
  await core.exec(await readFile("apps/api/migrations/151_public_medicine_market.sql", "utf8"));
  await market.exec(await readFile("apps/api/market-migrations/001_market.sql", "utf8"));
  const primary = adapter(core), isolated = adapter(market);
  // Historical source row: exact IDs, timestamp microseconds, nulls and decimals must survive copying.
  await core.query("INSERT INTO medicine_market_cards(kind,name,normalized_name,data,status,created_by,idempotency_key,created_at) VALUES('medicine','أصل','اصل',$1,'published',1,$2,'2026-10-29 12:01:02.123456+00')", [{ purchasePrice: "123.456789" }, randomUUID()]);
  const receipt = await transferMarket(primary, isolated);
  assert.equal(receipt.find(r => r.table === "medicine_market_cards")?.rows, 1);
  await assert.rejects(transferMarket(primary, isolated), /empty/);
  assert.equal((await core.query<{n:number}>("SELECT count(*)::int n FROM medicine_market_cards")).rows[0].n, 1);
  assert.equal((await market.query<{stamp:string}>("SELECT created_at::text stamp FROM medicine_market_cards")).rows[0].stamp, "2026-10-29 12:01:02.123456+00");
  const remote = await serve(createMarketApp(isolated, secret));
  t.after(remote.close);
  assert.equal((await request(remote.url, "GET", "/api/medicine-market/cards")).status, 401);
  const gateway = createMarketGateway(primary, { url: remote.url, secret, timeoutMs: 1000, concurrency: 2 });
  const business = express.Router(); business.use(gateway.router, medicineMarketRoutes(primary));
  const app = express();
  app.use("/api/medicine-market", gateway.admission);
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.get("x-test-user") === "owner" ? owner : req.get("x-test-user") === "member" ? member : null;
    if (user) req.auth = { user, tokenHash: "", csrf: "" };
    next();
  });
  app.post("/rpc", (req, res, next) => { try { dispatchApi(business, req, res, next, owner, "tijara_api_read", { operation: "GET /medicine-market/cards" }, 7); } catch (e) { next(e); } });
  app.use("/api", business);
  app.get("/sales-health", (_req, res) => res.json({ ok: true }));
  app.use(errors);
  const publicServer = await serve(app); t.after(publicServer.close);
  const call = (method: string, path: string, who = "", body?: unknown) => request(publicServer.url, method, "/api/medicine-market" + path, who, body);
  assert(apiCatalog(business, {}).operations.some((o: {operation:string}) => o.operation === "POST /medicine-market/cards"));
  assert.equal((await request(publicServer.url, "POST", "/rpc", "owner", {})).data.result.structuredContent.status, 200);
  assert.equal((await call("GET", "/cards")).data.total, 1);
  const input = { kind: "medicine", name: "اختبار الفصل", idempotencyKey: randomUUID() };
  const created = await call("POST", "/cards", "member", input);
  assert.equal(created.status, 201, JSON.stringify(created));
  const cardId = created.data.card.id;
  assert.equal(cardId, 2, "identity sequence continues after migration");
  assert.equal((await call("POST", "/cards", "member", input)).data.card.id, cardId);
  assert.equal((await call("GET", "/cards")).data.total, 1, "pending card is private");
  const contribution = (await call("GET", `/cards/${cardId}`, "member")).data.contributions[0];
  assert.equal((await call("POST", `/contributions/${contribution.id}/review`, "member", { decision: "approve" })).status, 403);
  assert.equal((await call("POST", `/contributions/${contribution.id}/review`, "owner", { decision: "approve" })).status, 200);
  const secretValue = "private ministry test";
  assert.equal((await call("POST", `/cards/${cardId}/contributions`, "owner", { fieldKey: "ministryNotes", value: secretValue, expectedValue: null, idempotencyKey: randomUUID() })).status, 201);
  assert(!JSON.stringify((await call("GET", `/cards/${cardId}`)).data).includes(secretValue));
  assert(JSON.stringify((await call("GET", `/cards/${cardId}`, "owner")).data).includes(secretValue));
  await core.exec("UPDATE users SET suspended=true WHERE id=2");
  assert.equal((await call("PUT", `/cards/${cardId}/reaction`, "member", { liked: true })).status, 403);
  await core.exec("INSERT INTO page_settings VALUES('public.medicine-market',NULL,false)");
  assert.equal((await call("GET", "/cards")).status, 403);
  await core.exec("DELETE FROM page_settings");
  assert.equal((await core.query<{n:number}>("SELECT count(*)::int n FROM medicine_market_cards")).rows[0].n, 1, "market mutations never write primary tables");
  assert.equal((await market.query<{n:number}>("SELECT count(*)::int n FROM medicine_market_cards")).rows[0].n, 2);
  assert.equal((await market.query<{invoices:null;sessions:null}>("SELECT to_regclass('invoices') invoices, to_regclass('sessions') sessions")).rows[0].invoices, null);
  assert.equal((await call("GET", "/audit", "member")).status, 403);
  assert((await call("GET", "/audit", "owner")).data.total > 0);
  await remote.close();
  assert.equal((await call("GET", "/cards")).status, 503);
  assert.equal((await request(publicServer.url, "GET", "/sales-health")).status, 200);
  assert.equal((await core.query<{n:number}>("SELECT count(*)::int n FROM medicine_market_cards")).rows[0].n, 1);
});

test("market overload rejects excess work before auth queries and times out without retries", async t => {
  let received = 0, authReads = 0;
  const slow = express();
  slow.use((_req, _res) => { received++; });
  const remote = await serve(slow); t.after(remote.close);
  const pool = { query: async () => { authReads++; return { rows: [] }; } } as unknown as Pool;
  const gate = createMarketGateway(pool, { url: remote.url, secret, concurrency: 1, timeoutMs: 150 });
  const app = express(); app.use("/api", gate.router); app.get("/sales-health", (_req, res) => res.json({ ok: true })); app.use(errors);
  const server = await serve(app); t.after(server.close);
  const first = request(server.url, "GET", "/api/medicine-market/cards");
  const until = Date.now() + 3000;
  while (!received && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(received, 1);
  assert.equal((await request(server.url, "GET", "/api/medicine-market/cards")).status, 503);
  assert.equal(authReads, 1, "excess market request must not touch primary auth DB");
  assert.equal((await request(server.url, "GET", "/sales-health")).status, 200);
  assert.equal((await first).status, 503);
  assert.equal(received, 1, "no automatic HTTP retry");
  await request(server.url, "GET", "/api/medicine-market/cards");
  await request(server.url, "GET", "/api/medicine-market/cards");
  const before = authReads;
  assert.equal((await request(server.url, "GET", "/api/medicine-market/cards")).status, 503);
  assert.equal(authReads, before, "open circuit avoids auth and upstream work");
});

test("private market Blueprint wiring does not cut over without an explicit enable flag", () => {
  const vars = ["MARKET_SERVICE_URL", "MARKET_SERVICE_HOSTPORT", "MARKET_SERVICE_ENABLED", "MARKET_SERVICE_SECRET"] as const;
  const saved = vars.map(key => [key, process.env[key]] as const);
  try {
    delete process.env.MARKET_SERVICE_URL;
    process.env.MARKET_SERVICE_HOSTPORT = "market-private.internal:3000";
    process.env.MARKET_SERVICE_SECRET = secret;
    delete process.env.MARKET_SERVICE_ENABLED;
    assert.equal(marketGatewayOptions(), undefined, "Blueprint provisioning alone cannot activate market isolation");
    process.env.MARKET_SERVICE_URL = "http://unexpected-private-market.internal:3000";
    assert.equal(marketGatewayOptions(), undefined, "an explicit URL must not bypass opt-in");
    process.env.MARKET_SERVICE_ENABLED = "0";
    assert.equal(marketGatewayOptions(), undefined, "disabled flag blocks explicit URL");
    delete process.env.MARKET_SERVICE_URL;
    process.env.MARKET_SERVICE_ENABLED = "1";
    assert.deepEqual(marketGatewayOptions(), { url: "http://market-private.internal:3000", secret });
    delete process.env.MARKET_SERVICE_HOSTPORT;
    assert.throws(() => marketGatewayOptions(), /requires MARKET_SERVICE_HOSTPORT/);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
