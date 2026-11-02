import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contracts = JSON.parse(
  readFileSync(new URL("../apps/api/src/mcp-contracts.json", import.meta.url), "utf8"),
);

test("MCP catalog accepts create returns and edit warehouse/returns without altering identity", () => {
  const create = contracts["POST /companies/:companyId/locations"].bodySchema;
  const patch = contracts["PATCH /companies/:companyId/locations/:id"].bodySchema;
  assert.deepEqual(create.properties.kind.enum, ["showroom", "warehouse", "returns"]);
  assert.deepEqual(patch.properties.kind.enum, ["warehouse", "returns"]);
  assert.deepEqual(Object.keys(patch.properties).sort(), ["active", "kind", "name"]);
  assert.equal(create.required.includes("code"), false, "codes are allocated by the server");
  assert.equal(patch.additionalProperties, false);
});
