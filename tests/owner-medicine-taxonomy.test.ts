import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { ownerMedicineTaxonomyRoutes } from "../apps/api/src/routes-owner-medicine-taxonomy.ts";
import { HttpError } from "../apps/api/src/errors.ts";

test("medicine taxonomy stays private and saves independent classifications without loss", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE users(id integer PRIMARY KEY,name text,display_name text,email text,phone text,image text,kind text,
      owner boolean DEFAULT false,archived boolean DEFAULT false,suspended boolean DEFAULT false,editor boolean DEFAULT false,monitor boolean DEFAULT false,created_at timestamptz DEFAULT now());
    INSERT INTO users(id,display_name,kind,owner,suspended) VALUES
      (1,'Owner','admin',true,false),(2,'Admin','admin',false,false),(3,'Suspended','admin',true,true);
  `);
  const migration = await readFile("apps/api/migrations/20261120_owner_medicine_taxonomy_draft.sql", "utf8");
  await db.exec(migration);
  await db.exec(migration);
  const query = db.query.bind(db);
  const client = { query, release() {} };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get("x-test-user") ?? "0");
    if (id) req.auth = { user: { id } as User, tokenHash: "test", csrf: "test", visitorOnly: req.get("x-test-visitor") === "yes" };
    next();
  });
  app.use("/api", ownerMedicineTaxonomyRoutes({ query, connect: async () => client } as unknown as Pool));
  const errors: ErrorRequestHandler = (e, _req, res, _next) => {
    res.status(e instanceof HttpError ? e.status : 500).json({ code: e.code, message: e.message });
  };
  app.use(errors);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.close(); });
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const url = "http://127.0.0.1:" + addr.port + "/api/owner/medicine-taxonomy";
  const get = (user: number, visitor = false) => fetch(url, { headers: { "x-test-user": String(user), "x-test-visitor": visitor ? "yes" : "no" } });
  const put = (user: number, body: unknown, visitor = false) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", "x-test-user": String(user), "x-test-visitor": visitor ? "yes" : "no" }, body: JSON.stringify(body) });
  const first = await get(1);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await first.json(), { revision: 0, classifications: [] });
  for (const [id, visitor, status] of [[0,false,401],[2,false,403],[1,true,403],[3,false,403]] as const) {
    assert.equal((await get(id, visitor)).status, status);
    assert.equal((await put(id, { expectedRevision: 0, classifications: [] }, visitor)).status, status);
  }
  const a = { id: "99999999-9999-4999-8999-999999999999", title: "تصنيف أول", notes: "ملاحظة إدارية" };
  const b = { id: "88888888-8888-4888-8888-888888888888", title: "تصنيف ثانٍ", notes: "" };
  const result = await put(1, { expectedRevision: 0, classifications: [a, b] });
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
  assert.deepEqual(await result.json(), { revision: 1, classifications: [a, b] });
  assert.equal((await put(1, { expectedRevision: 0, classifications: [a] })).status, 409);
  assert.equal((await put(1, { expectedRevision: 1, classifications: [a] })).status, 400);
  assert.equal((await put(1, { expectedRevision: 1, classifications: [a, { ...b, title: a.title + " " }] })).status, 400);
  assert.equal((await put(1, { expectedRevision: 1, classifications: [{ ...a, compositionId: 1 }, b] })).status, 400);
  const updated = { ...a, title: "اسم مصحح" };
  assert.equal((await put(1, { expectedRevision: 1, classifications: [updated, b] })).status, 200);
  assert.deepEqual(await (await get(1)).json(), { revision: 2, classifications: [updated, b] });
});
