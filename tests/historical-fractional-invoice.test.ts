import assert from "node:assert/strict";
import { test } from "node:test";
import { batchSchema } from "../apps/api/src/routes-transaction-import-schemas.ts";
import { allowsLegacyStockVariance, convertHistoricalFractionalLine } from "../apps/api/src/services/historical-fractional-invoice.ts";

const item = { id: 35, factor2: 10, factor3: 1, unit2_name: "حبة", unit3_name: "جزء" };
const make = (quantity: string, unitPrice = "4000") => ({
  itemId: 35, quantity, unitPrice, unit: 1 as const, originalLineId: null,
});
test("signed historical fractional quantity converts to physical smaller unit exactly", () => {
  const p = convertHistoricalFractionalLine(make("0.1"), item);
  assert.equal(p.quantity, "1");
  assert.equal(p.unit, 2);
  assert.equal(p.unitPrice, "400");
  const n = convertHistoricalFractionalLine(make("-0.2"), item);
  assert.equal(n.quantity, "-2");
  assert.equal(n.unitPrice, "400");
  assert.equal(n.unit, 2);
});
test("fractional quantity with unavailable smallest stock is not rounded", () => {
  assert.throws(() => convertHistoricalFractionalLine(make("-0.04"), item),
    /لا توجد وحدة أصغر/);
});
test("staged and posted historical schema both accept signed six-place fractions", () => {
  const batch = {
    idempotencyKey: "acacacac-2026-4a00-8000-000000000001",
    sourceSystem: "dar-aldawa-legacy-2026-10",
    postingDate: "2026-10-29",
    preserveDocumentDates: true,
    documents: [{
      type: "invoice" as const, sourceId: "261029000011111",
      sourceDocumentNumber: "261029000011111",
      sourceCreatedAt: "2026-10-29T09:00:00+03:00",
      sourceCreators: ["legacy"], sourceMovementIds: ["1"],
      sourceRows: [{ "معرف_الصنف": "35" }],
      payload: {
        idempotencyKey: "bcbcbcbc-2026-4a00-8000-000000000001",
        kind: "sale" as const, documentDate: "2026-10-29",
        currencyId: 7, branchId: 2, locationId: 2, counterpartyAccountId: 2414,
        lines: [{
          itemId: 35, unit: 1 as const, quantity: "-0.125000",
          unitPrice: "4000", originalLineId: null,
        }],
      },
    }],
  };
  assert.equal(batchSchema.safeParse(batch).success, true);
  assert.equal(batchSchema.safeParse({
    ...batch, documents: [{ ...batch.documents[0],
      payload: { ...batch.documents[0].payload,
        lines: [{ ...batch.documents[0].payload.lines[0], quantity: "-0.1234567" }] },
    }],
  }).success, false);
});

test("owner-scoped inventory variance keeps signed amount at currency precision", () => {
  const unrepresentable = make("-0.04", "4000");
  const converted = convertHistoricalFractionalLine(unrepresentable, item,
    { currencyDecimals: 0 });
  assert.equal(converted.unit, 1);
  assert.equal(converted.quantity, "-1");
  assert.equal(converted.unitPrice, "160");
  // Default behavior remains strict outside the specifically authorized run.
  assert.throws(() => convertHistoricalFractionalLine(unrepresentable, item),
    /لا توجد وحدة أصغر/);
  const odd = convertHistoricalFractionalLine(make("0.123456", "99"),
    { ...item, factor2: 1, factor3: 1 }, { currencyDecimals: 0 });
  assert.equal(odd.quantity, "1");
  assert.equal(odd.unitPrice, "12");
});

test("inventory variance exception is limited to company 2 legacy sales through November 1", () => {
  const allow = (companyId: number, source: string, kind: string, date: string) =>
    allowsLegacyStockVariance(companyId, source, kind, date);
  assert.equal(allow(2, "dar-aldawa-legacy-2026-10", "sale", "2026-10-31"), true);
  assert.equal(allow(2, "dar-aldawa-legacy-2026-10", "sale", "2026-11-01"), true);
  assert.equal(allow(2, "dar-aldawa-legacy-2026-10", "sale", "2026-11-02"), false);
  assert.equal(allow(2, "dar-aldawa-legacy-2026-10", "purchase", "2026-11-01"), false);
  assert.equal(allow(1, "dar-aldawa-legacy-2026-10", "sale", "2026-11-01"), false);
  assert.equal(allow(2, "another-source", "sale", "2026-11-01"), false);
  assert.equal(allow(2, "dar-aldawa-legacy-2026-10", "sale", "2026-09-30"), false);
});
