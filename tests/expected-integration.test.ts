import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import type { Pool } from "pg";
import { businessRoutes } from "../apps/api/src/business-routes.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";
import { requestPageKeys } from "../apps/api/src/services/pages.ts";
import { requestPermissionTargets } from "../apps/api/src/services/permission-rules.ts";
import { pageDefinitions, pageKeyForLocation } from "../packages/contracts/src/pages.ts";

const unusedPool = { query() { throw new Error("Integration metadata must not query live data"); } } as unknown as Pool;
const router = businessRoutes(unusedPool);
const request = (method: string, suffix: string) => ({
  method, originalUrl: `/api/companies/2/${suffix}`, query: {}, body: {},
}) as Request;

test("expected routes publish complete contracts on the shared browser and OAuth router", () => {
  const paths = [
    "GET /companies/:companyId/expected-cards",
    "POST /companies/:companyId/expected-cards",
    "GET /companies/:companyId/expected-cards/:id",
    "GET /companies/:companyId/expected-sections",
    "GET /companies/:companyId/expected-accounts",
    "GET /companies/:companyId/expected-cashboxes",
    "GET /companies/:companyId/expected-movements",
    "PATCH /companies/:companyId/expected-movements/:id",
    "POST /companies/:companyId/expected-movements/:id/complete",
    "GET /companies/:companyId/expected-movements/sections",
  ];
  for (const operation of paths) {
    const result = apiCatalog(router, { operation });
    assert.equal(result.operations.length, 1, operation);
    const contract = result.operations[0] as Record<string, any>;
    assert.equal(contract.operation, operation);
    assert.equal(contract.source, "routes-expected.ts");
    assert(contract.pathParams.includes("companyId"));
    if (!operation.startsWith("GET")) {
      assert.equal(contract.bodySchema.type, "object");
      assert.equal(contract.bodySchema.additionalProperties, false);
    }
  }
  const creation = apiCatalog(router, { operation: paths[1] }).operations[0] as Record<string, any>;
  assert.equal(creation.bodySchema.properties.amount.type, "string");
  assert.equal(creation.bodySchema.properties.section.type, "string");
  assert.equal(creation.bodySchema.properties.startDate.format, "date");
  assert.equal(creation.bodySchema.properties.cashAccountId.default, null);
  assert(!creation.bodySchema.required.includes("cashAccountId"));
  assert(creation.bodySchema.required.includes("idempotencyKey"));
});

test("expected pages resolve once in the company directory without inheriting accounting pages", () => {
  for (const [name, suffix] of [["كروت المتوقع", "expected-cards"], ["حركة المتوقع", "expected-movements"]]) {
    const definitions = pageDefinitions.filter(page => page.key === `company.${suffix}`);
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, name);
    assert.equal(definitions[0].scope, "company");
    assert.equal(definitions[0].section, "المتوقع");
    assert.equal(definitions[0].parentKey, undefined);
    assert.equal(pageKeyForLocation(`/companies/2/${suffix}`, ""), `company.${suffix}`);
  }
});

test("expected authorization keeps completion as editing and lookups under card access", async () => {
  const cases = [
    ["GET", "expected-cards", "company.expected-cards", "view"],
    ["POST", "expected-cards", "company.expected-cards", "create"],
    ["GET", "expected-accounts", "company.expected-cards", "view"],
    ["GET", "expected-cashboxes", "company.expected-cards", "view"],
    ["GET", "expected-sections", "company.expected-cards", "view"],
    ["GET", "expected-movements", "company.expected-movements", "view"],
    ["GET", "expected-movements/sections", "company.expected-movements", "view"],
    ["PATCH", "expected-movements/7", "company.expected-movements", "edit"],
    ["POST", "expected-movements/7/complete", "company.expected-movements", "edit"],
  ];
  for (const [method, suffix, page, action] of cases) {
    const req = request(method, suffix);
    assert.deepEqual(await requestPageKeys(unusedPool, req), { companyId: 2, keys: [page] });
    assert.deepEqual(await requestPermissionTargets(unusedPool, req, 2), [[`${page}:${action}`]]);
  }
});
