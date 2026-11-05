import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Pool } from "pg";
import { explanationRoutes, explanationMcpSchemas } from "../apps/api/src/routes-explanations.ts";
import { pageRoutes } from "../apps/api/src/routes-pages.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";
import { listQuery } from "../apps/api/src/services/lists.ts";
import { guideMcpContracts } from "../scripts/mcp-guide-contracts.ts";

const published = JSON.parse(readFileSync(new URL("../apps/api/src/mcp-contracts.json", import.meta.url), "utf8"));
const unusedPool = {} as Pool;

test("guide catalog exposes generated schemas from the actual registered handlers", () => {
  const router = explanationRoutes(unusedPool);
  for (const [operation, metadata] of Object.entries(guideMcpContracts)) {
    assert.deepEqual(published[operation], metadata, `regeneration must preserve ${operation}`);
    const catalog = apiCatalog(operation === "GET /page-catalog" ? pageRoutes(unusedPool) : router, { operation });
    assert.equal(catalog.operations.length, 1, operation);
    assert.deepEqual(catalog.operations[0], {
      operation,
      tool: operation.startsWith("GET ") ? "tijara_api_read" : "tijara_api_write",
      ...metadata,
    });
  }
});

test("guide document query publishes exact all/offset types and bounded strict pagination", () => {
  const schema = explanationMcpSchemas.documentQuery;
  assert.deepEqual(schema.parse({}), { offset: 0 });
  assert.deepEqual(schema.parse({ offset: "170", all: "true" }), { offset: 170, all: "true" });
  for (const query of [{ offset: -1 }, { offset: 1000001 }, { offset: "1.5" }, { all: true }, { page: "2" }])
    assert.equal(schema.safeParse(query).success, false, JSON.stringify(query));
  const contract = published["GET /explanations/groups/:groupId/document"];
  assert.deepEqual(contract.queryFields, ["offset", "all"]);
  assert.deepEqual(contract.querySchema.properties.all.enum, ["true", "false"]);
  assert.equal(contract.querySchema.additionalProperties, false);
  assert.equal(contract.querySchema.properties.offset.maximum, 1000000);
});

test("guide creation contract preserves defaults, full text, and strict ACL limits", () => {
  const schema = explanationMcpSchemas.createNode;
  assert.deepEqual(schema.parse({ groupId: 3 }), {
    title: "", body: "", evidence: "", kind: "paragraph", color: null,
    fontSize: null, readAcl: null, editAcl: null, groupId: 3, parentId: null, afterId: null,
  });
  const valid = { groupId: 3, parentId: 354, body: "x".repeat(250000), evidence: "e".repeat(100000), readAcl: { users: [1], kinds: ["admin"] } };
  assert.equal(schema.safeParse(valid).success, true);
  for (const body of [
    { ...valid, body: valid.body + "x" }, { groupId: 0 }, { groupId: 3, parentId: -1 },
    { groupId: 3, readAcl: { users: [0] } }, { groupId: 3, readAcl: { users: [], owner: true } },
    { groupId: 3, fontSize: 37 }, { groupId: 3, revision: 1 },
  ]) assert.equal(schema.safeParse(body).success, false);
  const contract = published["POST /explanations/nodes"].bodySchema;
  assert.deepEqual(contract.required, ["groupId"]);
  assert.equal(contract.additionalProperties, false);
  assert.equal(contract.properties.body.maxLength, 250000);
  assert.equal(contract.properties.evidence.maxLength, 100000);
});

test("page catalog advertises all helper pagination and dynamic filter fields", () => {
  const contract = published["GET /page-catalog"];
  assert.deepEqual([...contract.queryFields].sort(), ["companyId", "page", "pageSize", "q", "scope", "section", "sort", "status", "type"]);
  const query = listQuery({ page: "2", pageSize: "100", q: " guides ", sort: "order:asc" }, { id: "id", order: "order" }, "order:asc");
  assert.equal(query.offset, 100);
  assert.equal(query.pageSize, 100);
  assert.equal(query.q, "guides");
  assert.throws(() => listQuery({ pageSize: "101" }, { id: "id" }));
});
