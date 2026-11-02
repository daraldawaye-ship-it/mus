import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

const route = readFileSync(new URL("../apps/api/src/routes-inventory.ts", import.meta.url), "utf8");
const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/mcp-contracts.json", import.meta.url), "utf8"));
const op = catalog["POST /companies/:companyId/stock-transfers/legacy-batch"];

test("audited legacy transfer batch is exposed with bounded request contract", () => {
  assert.ok(op, "the connector must expose the route");
  assert.equal(op.bodySchema.properties.items.maxItems, 25);
  assert.equal(op.bodySchema.properties.items.minItems, 1);
  assert.deepEqual(op.bodySchema.required,
    ["documentDate","fromLocationId","toLocationId","sourceFileId","items"]);
  assert.equal(op.bodySchema.additionalProperties, false);
  assert.deepEqual(op.bodySchema.properties.items.items.required,
    ["legacyId","quantity","idempotencyKey"]);
  assert.match(route,/legacyTransferBatchSchema/);
  assert.match(route,/WHERE company_id=\$1 AND legacy_id=\$2/);
  assert.match(route,/await findStockOperation/);
  assert.match(route,/await auditStockOperation/);
  assert.match(route,/await applyStock/);
  assert.match(route,/companyId, row.legacyId/);
  assert.match(route,/pool, req, "inventory.post"/);
});
test("quantities in the batch contract must be positive integers after truncation", () => {
  const field = op.bodySchema.properties.items.items.properties.quantity;
  const quantity = z.string().regex(new RegExp(field.pattern));
  for (const value of ["21","1","2000"]) assert.equal(quantity.safeParse(value).success, true);
  for (const value of ["21.7","0","-5","1.2",""]) assert.equal(quantity.safeParse(value).success, false);
});
