import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { Router } from "express";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { questionRoutes } from "../apps/api/src/routes-questions.ts";
import { apiCatalog, apiOperations, dispatchApi } from "../apps/api/src/services/mcp-api.ts";
import { permissionRequest } from "../apps/api/src/services/permission-rules.ts";

test("MCP discovers and filters both public and company question route aliases", () => {
  // Register the real question routes without executing database queries.
  const router = Router().use(questionRoutes({} as Pool));
  router.get("/explanations/groups/:groupId/document", (_req, res) => res.json({}));
  assert.deepEqual(apiCatalog(router, { filter: "explanations" }).operations.map(({ operation }) => operation), [
    "GET /explanations/groups/:groupId/document",
  ]);
  const operations = apiOperations(router);
  assert(operations.every(({ path }) => typeof path === "string" && !path.includes(",")));

  const filtered = apiCatalog(router, { filter: "QUESTIONS" }).operations;
  for (const operation of [
    "GET /questions",
    "GET /companies/:companyId/questions",
    "GET /questions/categories",
    "GET /companies/:companyId/questions/categories",
    "POST /questions/:questionId/answers",
    "POST /companies/:companyId/questions/:questionId/answers",
  ]) {
    assert(filtered.some((entry) => entry.operation === operation), operation);
    assert.equal(apiCatalog(router, { operation }).operations.length, 1);
  }
  assert(filtered.every(({ operation }) => operation.toLowerCase().includes("questions")));
  assert(apiCatalog(router, { filter: "answers" }).operations.some(({ operation }) => operation === "GET /answers"));
  assert(apiCatalog(router, { filter: "answers" }).operations.some(({ operation }) => operation === "GET /companies/:companyId/answers"));
});

test("password aliases remain excluded independently of other paths on the same route", () => {
  const router = Router();
  router.post(["/users/:id/password", "/users/:id/profile"], (_req, res) => res.json({ ok: true }));
  assert.deepEqual(apiOperations(router), [{ method: "POST", path: "/users/:id/profile" }]);
  assert.deepEqual(apiCatalog(router, { filter: "password" }).operations, []);
});

test("MCP dispatches each alias through the same handler and company guard", async () => {
  const user: User = {
    id: 7, name: "Member", displayName: "Member", email: "member@example.test",
    phone: "", image: "", kind: "member", owner: false, archived: false,
    suspended: false, editor: false, monitor: false, createdAt: "2026-11-05T00:00:00Z",
  };
  const business = Router();
  business.get(["/questions", "/companies/:companyId/questions"], (req, res) => {
    assert(req.auth);
    assert.equal(req.auth.user, user);
    assert.equal(permissionRequest.getStore(), req);
    if (req.params.companyId && req.params.companyId !== "2") {
      res.status(403).json({ error: "company_forbidden" });
      return;
    }
    res.json({ companyId: req.params.companyId ?? null, actorId: req.auth.user.id, q: req.query.q });
  });
  const app = express();
  app.post("/mcp", express.json(), (req, res, next) => {
    dispatchApi(business, req, res, next, user, "tijara_api_read", req.body, 1);
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const read = async (operation: string, pathParams = {}) => {
      const response = await fetch(base + "/mcp", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, pathParams, query: { q: "test" } }),
      });
      assert.equal(response.status, 200);
      return await response.json() as {
        result: { structuredContent: { status: number; data: unknown }; isError?: boolean };
      };
    };
    assert.deepEqual((await read("GET /questions")).result.structuredContent, {
      status: 200, data: { companyId: null, actorId: 7, q: "test" },
    });
    assert.deepEqual((await read("GET /companies/:companyId/questions", { companyId: 2 })).result.structuredContent, {
      status: 200, data: { companyId: "2", actorId: 7, q: "test" },
    });
    const denied = await read("GET /companies/:companyId/questions", { companyId: 3 });
    assert.equal(denied.result.isError, true);
    assert.deepEqual(denied.result.structuredContent, { status: 403, data: { error: "company_forbidden" } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
