import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import express, { type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { createMarketApp } from "../apps/api/src/market/app.ts";
import { createMarketGateway } from "../apps/api/src/market/gateway.ts";
import { marketVerifier, signMarketRequest } from "../apps/api/src/market/transport.ts";

const secret = "market-image-recovery-test-secret-at-least-32-bytes";
const imageBatchPath = "/api/medicine-market/owner/images-batch";
const owner: User = {
  id: 1, name: "Owner", displayName: "Owner", email: "", phone: "", image: "",
  kind: "admin", owner: true, archived: false, suspended: false, editor: false,
  monitor: false, createdAt: "2026-11-25T00:00:00.000Z",
};
const member: User = { ...owner, id: 2, name: "Member", displayName: "Member", owner: false, kind: "member" };

async function serve(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function fixture(t: TestContext, delayMs = 0) {
  const received: { method: string; path: string; bytes: number; owner: boolean }[] = [];
  const verify = marketVerifier(secret);
  const upstream = express();
  upstream.use(express.text({ type: "application/json", limit: "2mb" }));
  upstream.use((req, res) => {
    const raw = typeof req.body === "string" ? req.body : "";
    const context = verify(req.method, req.originalUrl, req.get("x-market-context")!, req.get("x-market-signature")!, raw);
    received.push({ method: req.method, path: req.originalUrl, bytes: Buffer.byteLength(raw), owner: context.user?.owner === true });
    const finish = () => res.status(201).json({ saved: true, bytes: Buffer.byteLength(raw) });
    if (!delayMs) finish();
    else {
      const timer = setTimeout(finish, delayMs);
      res.once("close", () => clearTimeout(timer));
    }
  });
  const remote = await serve(upstream); t.after(remote.close);
  let ownerAuthority = true;
  const pool = {
    async query(sql: string, args?: unknown[]) {
      if (sql.includes("FROM users WHERE id=$1")) {
        const user = args?.[0] === owner.id ? { ...owner, owner: ownerAuthority } : member;
        return { rows: [{ ...user, display_name: user.displayName, created_at: user.createdAt }] };
      }
      assert(sql.includes("page_settings"), "the gateway may only read current authority and page settings");
      return { rows: [] };
    },
  } as unknown as Pool;
  const gateway = createMarketGateway(pool, { url: remote.url, secret, timeoutMs: 150, concurrency: 2 });
  const app = express();
  // The gateway, rather than Express's parser, must enforce both byte limits.
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    const user = req.get("x-test-user") === "member" ? member : owner;
    req.auth = { user, tokenHash: "", csrf: "", ...(req.get("x-test-user") === "visitor" ? { visitorOnly: true } : {}) };
    next();
  });
  app.use("/api", gateway.router);
  app.use(((error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: { code: error.code ?? "test_error" } });
  }) as ErrorRequestHandler);
  const server = await serve(app); t.after(server.close);
  const call = async (method: string, path: string, body?: unknown, who = "owner") => {
    const response = await fetch(server.url + path, {
      method, headers: { "content-type": "application/json", "x-test-user": who },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any };
  };
  return { received, call, revokeOwner: () => { ownerAuthority = false; } };
}

function imageBatchOfSize(bytes: number) {
  const empty = { items: [{ cardId: 1, dataUrl: "" }] };
  const body = { items: [{ cardId: 1, dataUrl: "x".repeat(bytes - Buffer.byteLength(JSON.stringify(empty))) }] };
  assert.equal(Buffer.byteLength(JSON.stringify(body)), bytes);
  return body;
}

test("owner image batches survive the ordinary command deadline and deliver the complete signed body once", async t => {
  const f = await fixture(t, 350), bytes = 96 * 1024;
  for (const path of [imageBatchPath, imageBatchPath + "/", imageBatchPath + "?trace=test"]) {
    const before = f.received.length;
    const result = await f.call("POST", path, imageBatchOfSize(bytes));
    assert.equal(result.status, 201, JSON.stringify(result));
    assert.deepEqual(result.data, { saved: true, bytes });
    assert.equal(f.received.length, before + 1, "an uncertain image upload must never be retried by the gateway");
    assert.deepEqual(f.received.at(-1), { method: "POST", path, bytes, owner: true });
  }
});

test("the larger image-batch allowance stops at 768 KiB and does not widen unrelated request bodies", async t => {
  const f = await fixture(t), limit = 768 * 1024;
  assert.equal((await f.call("POST", imageBatchPath, imageBatchOfSize(limit))).status, 201);
  assert.equal(f.received[0]?.bytes, limit);
  const before = f.received.length;
  for (const [path, bytes] of [
    [imageBatchPath, limit + 1],
    ["/api/medicine-market/owner/contributions-batch", 65537],
    [imageBatchPath + "/extra", 65537],
    ["/api/medicine-market/cards", 65537],
  ] as const) {
    const result = await f.call("POST", path, imageBatchOfSize(bytes));
    assert.equal(result.status, 413, path);
    assert.equal(result.data.error.code, "body_too_large", path);
    assert.equal(f.received.length, before, "oversized requests must be rejected before upstream delivery");
  }
  assert.equal((await f.call("POST", "/api/medicine-market/cards", imageBatchOfSize(65536))).status, 201);
  assert.equal(f.received.at(-1)?.bytes, 65536);
});

test("the longer deadline requires the image-batch POST and current owner authority", async t => {
  for (const item of [
    { method: "GET", path: imageBatchPath, who: "owner", revoked: false },
    { method: "POST", path: "/api/medicine-market/owner/contributions-batch", who: "owner", revoked: false },
    { method: "POST", path: imageBatchPath + "/extra", who: "owner", revoked: false },
    { method: "POST", path: imageBatchPath, who: "member", revoked: false },
    { method: "POST", path: imageBatchPath, who: "visitor", revoked: false },
    { method: "POST", path: imageBatchPath, who: "owner", revoked: true },
  ]) {
    await t.test(`${item.method} ${item.path} as ${item.who}${item.revoked ? " after ownership removal" : ""}`, async sub => {
      const f = await fixture(sub, 350);
      if (item.revoked) f.revokeOwner();
      const result = await f.call(item.method, item.path, item.method === "GET" ? undefined : { items: [] }, item.who);
      assert.equal(result.status, 503, "ordinary calls must still expire before the 350 ms upstream response");
      assert.equal(result.data.error.code, "market_unavailable");
      assert.equal(f.received.length, 1, "timed out commands are not automatically resent");
    });
  }
});

test("the private market parser admits signed image batches above 64 KiB but keeps its 768 KiB ceiling", async t => {
  let databaseCalls = 0;
  const pool = {
    async query() { databaseCalls++; throw new Error("invalid input must not reach the database"); },
    async connect() { databaseCalls++; throw new Error("invalid input must not open a transaction"); },
  } as unknown as Pool;
  const server = await serve(createMarketApp(pool, secret)); t.after(server.close);
  const call = async (path: string, raw: string, signed = true) => {
    const response = await fetch(server.url + path, {
      method: "POST", headers: {
        "content-type": "application/json",
        ...(signed ? signMarketRequest(secret, "POST", path, owner, [], raw) : {}),
      }, body: raw,
    });
    return { status: response.status, data: await response.json() as any };
  };
  // Invalid fields deliberately stop at route validation, before any write or download.
  const invalid = JSON.stringify({ padding: "x".repeat(70 * 1024) });
  assert(Buffer.byteLength(invalid) > 65536);
  for (const path of [imageBatchPath, imageBatchPath + "/?trace=test"]) {
    const result = await call(path, invalid);
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.equal(result.data.error.code, "validation");
  }
  assert.equal((await call(imageBatchPath, invalid, false)).status, 401, "the larger parser cannot bypass signed transport");
  const unrelated = await call("/api/medicine-market/owner/contributions-batch", invalid);
  assert.equal(unrelated.status, 413);
  assert.equal(unrelated.data.error.code, "body_too_large");
  const oversized = await call(imageBatchPath, JSON.stringify(imageBatchOfSize(768 * 1024 + 1)));
  assert.equal(oversized.status, 413);
  assert.equal(oversized.data.error.code, "body_too_large");
  assert.equal(databaseCalls, 0, "body limits and schema failures must not read or write market data");
});
