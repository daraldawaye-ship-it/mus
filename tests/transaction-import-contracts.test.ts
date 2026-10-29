import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { batchSchema, stagingBatchSchema } from "../apps/api/src/routes-transaction-import-schemas.ts";
import { mcpBodySchemas } from "../apps/api/src/routes-transaction-import-staging.ts";

const contracts = JSON.parse(
  readFileSync(new URL("../apps/api/src/mcp-contracts.json", import.meta.url), "utf8"),
) as Record<string, any>;
const root = "/companies/:companyId/transaction-import";
const invoice = {
  type: "invoice" as const,
  sourceId: "legacy-3416",
  sourceDocumentNumber: "3416",
  sourceCreatedAt: "2013-09-06T23:13:24+03:00",
  sourceCreators: ["historical"],
  sourceMovementIds: ["movement-1"],
  sourceRows: [{ original: "historical-row" }],
  payload: {
    idempotencyKey: "8132f0aa-9a61-5344-9484-21e6ab736905",
    kind: "purchase" as const,
    documentDate: "2013-09-06",
    currencyId: 7,
    branchId: 2,
    locationId: 2,
    counterpartyAccountId: 338,
    supplierAccountId: 190,
    doctorId: null,
    doctorName: "",
    lines: [{ itemId: 502, unit: 1 as const, quantity: "5", unitPrice: "310" }],
  },
};
const batch = {
  idempotencyKey: "845dbaf3-5c53-4e6a-b115-5f9d2f7d65c0",
  sourceSystem: "dar-aldawa-legacy-2026-10",
  postingDate: "2013-09-06",
  documents: [invoice],
};

test("staging and posting accept historical integer purchase without dropping doctor fields", () => {
  assert.equal(stagingBatchSchema.safeParse(batch).success, true);
  assert.equal(batchSchema.safeParse(batch).success, true);
  const post = contracts["POST " + root + "/batch"].bodySchema;
  const props = post.properties.documents.items.oneOf.find((x: any) => x.properties.type.const === "invoice").properties.payload.properties;
  assert.ok(props.doctorId);
  assert.ok(props.doctorName);
  assert.equal(post.properties.documents.maxItems, 300);
});

test("fractional quantity stays accepted in staging but is never silently rounded for posting", () => {
  const withFraction = {
    ...batch,
    documents: [{ ...invoice, payload: {
      ...invoice.payload,
      lines: [{ ...invoice.payload.lines[0], quantity: "1.000001" }],
    }}],
  };
  assert.equal(stagingBatchSchema.safeParse(withFraction).success, true);
  assert.equal(batchSchema.safeParse(withFraction).success, false);
  const stage = contracts["POST " + root + "/stage"].bodySchema;
  assert.match(stage.properties.documents.items.oneOf.find((x: any) => x.properties.type.const === "invoice").properties.payload.properties.lines.items.properties.quantity.pattern, /d\{1,6\}/);
});

test("stage acknowledgement has a strict, published contract", () => {
  const receipt = {
    sourceSystem: batch.sourceSystem,
    completed: [{ type: "invoice", sourceId: invoice.sourceId }],
    failed: [],
  };
  assert.equal(mcpBodySchemas.receiptSchema.safeParse(receipt).success, true);
  assert.equal(mcpBodySchemas.receiptSchema.safeParse({ ...receipt, unapproved: true }).success, false);
  const ack = contracts["POST " + root + "/stage-ack"];
  assert.equal(ack.bodyContract, "receiptSchema");
  assert.deepEqual(ack.bodySchema.required, ["sourceSystem", "completed", "failed"]);
  assert.equal(ack.bodySchema.properties.completed.maxItems, 300);
});

test("mixed historical posting dates require an explicit preserveDocumentDates flag", () => {
  const mixed = { ...batch, postingDate: "2026-10-29" };
  assert.equal(batchSchema.safeParse(mixed).success, false);
  assert.equal(batchSchema.safeParse({ ...mixed, preserveDocumentDates: false }).success, false);
  assert.equal(batchSchema.safeParse({ ...mixed, preserveDocumentDates: true }).success, true);
  assert.equal(contracts["POST " + root + "/batch"].bodySchema.properties.preserveDocumentDates.type, "boolean");
});
