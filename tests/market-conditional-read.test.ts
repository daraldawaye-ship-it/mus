import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Pool } from "pg";
import { sendMarketRead } from "../apps/api/src/market/conditional-read.ts";
import { createMarketGateway } from "../apps/api/src/market/gateway.ts";

async function serve(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test("market validators cover the entire authorized result and never bypass an access refusal", async t => {
  let payload = { items: [{ id: 1, image: "one", opens: 3, myLiked: false }], total: 1 };
  let allowed = true, checked = 0;
  const app = express();
  app.get("/cards", (req, res) => {
    checked++;
    if (!allowed) { res.status(403).json({ error: { message: "denied" } }); return; }
    sendMarketRead(req, res, payload);
  });
  const server = await serve(app); t.after(server.close);
  const first = await fetch(server.url + "/cards");
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), payload);
  const tag = first.headers.get("etag"); assert.ok(tag);
  assert.equal(first.headers.get("cache-control"), "private, no-cache");
  assert.match(first.headers.get("vary") ?? "", /Cookie/);
  const unchanged = await fetch(server.url + "/cards", { headers: { "if-none-match": tag, "cache-control": "no-cache" } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  assert.equal(unchanged.headers.get("etag"), tag);
  assert.equal(checked, 2, "authorization is still checked on conditional reads");
  payload = { ...payload, items: [{ ...payload.items[0]!, opens: 4 }] };
  const counterChange = await fetch(server.url + "/cards", { headers: { "if-none-match": tag } });
  assert.equal(counterChange.status, 200);
  assert.notEqual(counterChange.headers.get("etag"), tag);
  const secondTag = counterChange.headers.get("etag")!;
  payload = { ...payload, items: [{ ...payload.items[0]!, myLiked: true }] };
  const viewerChange = await fetch(server.url + "/cards", { headers: { "if-none-match": secondTag } });
  assert.equal(viewerChange.status, 200);
  assert.notEqual(viewerChange.headers.get("etag"), secondTag);
  allowed = false;
  const denied = await fetch(server.url + "/cards", { headers: { "if-none-match": viewerChange.headers.get("etag")! } });
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /denied/);
});

test("market gateway forwards conditional validators and returns an empty 304 instead of parsing JSON", async t => {
  let receivedValidator: string | undefined, calls = 0, allow = true;
  const upstream = express();
  upstream.get("/api/medicine-market/cards", (req, res) => {
    calls++;
    receivedValidator = req.get("if-none-match");
    if (!allow) { res.status(403).json({ error: { code: "forbidden", message: "denied" } }); return; }
    sendMarketRead(req, res, { items: [{ id: 1, name: "saved" }], total: 1 });
  });
  const remote = await serve(upstream); t.after(remote.close);
  let authorityChecks = 0;
  const pool = { query: async () => { authorityChecks++; return { rows: [] }; } } as unknown as Pool;
  const gateway = createMarketGateway(pool, { url: remote.url, secret: "market-conditional-test-at-least-32-byte-secret" });
  const app = express(); app.use("/api", gateway.router);
  const server = await serve(app); t.after(server.close);
  const path = server.url + "/api/medicine-market/cards";
  const first = await fetch(path);
  assert.equal(first.status, 200);
  const tag = first.headers.get("etag"); assert.ok(tag);
  const second = await fetch(path, { headers: { "if-none-match": tag } });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
  assert.equal(second.headers.get("etag"), tag);
  assert.equal(receivedValidator, tag);
  assert.equal(calls, 2);
  assert.ok(authorityChecks >= 2);
  assert.equal(second.headers.get("cache-control"), "private, no-cache");
  allow = false;
  const rejected = await fetch(path, { headers: { "if-none-match": tag } });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json() as { error: { code: string } }).error.code, "forbidden");
});
