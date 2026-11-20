import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import express, { type ErrorRequestHandler } from "express";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import type { MarketAccess } from "../apps/api/src/routes-medicine-market.ts";
import { marketStagingRoutes } from "../apps/api/src/routes-market-staging.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";
import { HttpError } from "../apps/api/src/errors.ts";

test("Medawee verification and current agent link are owner-only, atomic and revisioned", async () => {
  const db = new PGlite();
  for (const migration of ["001_market", "20261120_medawee_agent_manufacturers_staging", "20261120_medawee_manufacturer_verification", "20261120_medawee_manufacturer_verification_link"])
    await db.exec(await readFile(new URL(`../apps/api/market-migrations/${migration}.sql`, import.meta.url), "utf8"));
  const query = db.query.bind(db);
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const access = {
    viewer: async (_db, req) => ({ owner: req.header("x-test-owner") === "yes" }) as User,
    enabled: async () => {},
  } as MarketAccess;
  const app = express();
  const route = "/medicine-market/staging/medawee-agents";
  const router = marketStagingRoutes(pool, access, true);
  const contract = apiCatalog(router, { operation: `PATCH ${route}` }).operations[0];
  assert.equal(contract?.tool, "tijara_api_write");
  assert.equal(contract && "bodyContract" in contract && contract.bodyContract, "medaweeManufacturerVerificationSchema");
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    if (!(err instanceof HttpError)) throw err;
    res.status(err.status).json({ error: err.message });
  };
  app.use(express.json(), router, errors);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}${route}`;
  const agentUrl = `https://medawee.com/medicines/entity/agent/${"1".repeat(24)}`;
  const call = (method: string, entries?: unknown[], owner = true) => fetch(url, {
    method, headers: { "content-type": "application/json", "x-test-owner": owner ? "yes" : "no" },
    body: entries ? JSON.stringify({ entries }) : undefined,
  });
  const first = { agentUrl, manufacturerName: "Alpha", expectedRevision: 0, manufacturerVerified: true };
  const second = { ...first, manufacturerName: "Beta" };
  try {
    assert.equal((await call("POST", ["Alpha", "Beta"].map(manufacturerName =>
      ({ agentName: "Agent", manufacturerName, agentUrl })))).status, 200);
    assert.equal((await call("PATCH", [first], false)).status, 403);
    assert.equal((await call("PATCH", [first, first])).status, 400);
    assert.equal((await call("PATCH", [first, { ...second, expectedRevision: 5 }])).status, 409);
    const before = (await (await call("GET")).json()).items;
    assert.deepEqual(before.map((row: { manufacturerVerified: boolean }) => row.manufacturerVerified), [false, false]);
    assert.equal((await call("PATCH", [first])).status, 200);
    assert.equal((await call("PATCH", [first])).status, 409);
    const after = (await (await call("GET")).json()).items;
    assert.deepEqual(after[0], {
      agentName: "Agent", manufacturerName: "Alpha", agentUrl, completionStatus: "pending",
      revision: 1, manufacturerVerified: true, manufacturerAgentLinked: false, duplicateAgent: false,
      linkedManufacturerCardId: null, linkedAgentCardId: null, manufacturerVerificationLabel: "تم التأكد من الإضافة فقط",
    });
    assert.equal(after[1].manufacturerVerified, false);

    await db.exec(`INSERT INTO users(id,display_name) VALUES(1,'Owner');
      INSERT INTO medicine_market_cards(kind,name,normalized_name,status,created_by,idempotency_key,data) VALUES
        ('agent','Agent','agent','published',1,'d0000001-0000-4000-8000-000000000001','{}'),
        ('agent','Other','other','published',1,'d0000001-0000-4000-8000-000000000002','{}'),
        ('manufacturer','Alpha','alpha','published',1,'d0000001-0000-4000-8000-000000000003','{"agentId":1}')`);
    const link = { ...first, expectedRevision: 1, agentLink: { manufacturerCardId: 3, agentCardId: 1 } };
    assert.equal((await call("PATCH", [link], false)).status, 403);
    assert.equal((await call("PATCH", [{ ...link, manufacturerVerified: false }])).status, 400);
    assert.equal((await call("PATCH", [{ ...link, agentLink: { manufacturerCardId: 3, agentCardId: 2 } }])).status, 409);
    const linked = await call("PATCH", [link]);
    assert.equal(linked.status, 200);
    const expectedLinkedRow = {
      ...after[0], revision: 2, manufacturerAgentLinked: true, linkedManufacturerCardId: 3, linkedAgentCardId: 1,
      manufacturerVerificationLabel: "تم التأكد من الإضافة فقط _ تم ربط المصنع بالوكيل",
    };
    assert.deepEqual((await linked.json()).items[0], expectedLinkedRow);
    assert.deepEqual((await (await call("GET")).json()).items[0], expectedLinkedRow);

    const anotherAgentUrl = `https://medawee.com/medicines/entity/agent/${"2".repeat(24)}`;
    assert.equal((await call("POST", [
      { agentName: "Other", manufacturerName: "Alpha", agentUrl: anotherAgentUrl },
    ])).status, 200);
    const repeated = (await (await call("GET")).json()).items;
    assert.deepEqual(repeated.filter((row: { manufacturerName: string }) => row.manufacturerName === "Alpha")
      .map((row: { duplicateAgent: boolean; manufacturerVerificationLabel: string }) =>
        [row.duplicateAgent, row.manufacturerVerificationLabel]), [[true, "وكيل مكرر"], [true, "وكيل مكرر"]]);
    assert.equal(repeated.find((row: { manufacturerName: string }) => row.manufacturerName === "Beta").duplicateAgent, false);
    assert.equal(repeated[0].manufacturerAgentLinked, true);
    await db.query("DELETE FROM medawee_agent_manufacturers_staging WHERE agent_url=$1", [anotherAgentUrl]);

    await db.exec("UPDATE medicine_market_cards SET archived=true WHERE id=1");
    const stale = (await (await call("GET")).json()).items[0];
    assert.equal(stale.manufacturerAgentLinked, false);
    assert.equal(stale.manufacturerVerificationLabel, "تم التأكد من الإضافة فقط");
    const cleared = await call("PATCH", [{ ...first, expectedRevision: 2, manufacturerVerified: false }]);
    assert.equal(cleared.status, 200);
    assert.deepEqual((await cleared.json()).items[0], {
      ...after[0], revision: 3, manufacturerVerified: false, manufacturerVerificationLabel: "",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
  }
});
