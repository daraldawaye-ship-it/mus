import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  settlementDuePredicate,
  manualStocktakeRequestPredicate,
  settlementFollowUpFrom,
} from "../apps/api/src/services/settlement-due.ts";

test("periodic stocktake interval has a 1.5-day SQL minimum", async () => {
  const from = settlementFollowUpFrom("$1");
  const match = from.match(
    /LEFT JOIN LATERAL \(\s*SELECT (GREATEST\([\s\S]*?) AS raw_limit\s*\) count_limit ON true/,
  );
  assert.ok(match, "Shared stocktake limit SQL must be present");
  const limitExpression = match[1];
  assert.match(limitExpression, /^GREATEST\(1\.5::numeric,/);
  assert.match(settlementDuePredicate, /count_limit\.raw_limit/);

  const db = new PGlite();
  try {
    const cases = [
      { importance: 8, monthlySales: 0, expected: 48 },
      { importance: 8, monthlySales: 20, expected: 9.6 },
      { importance: 8, monthlySales: 100, expected: 240 / 105 },
      { importance: 8, monthlySales: 154, expected: 240 / 159 },
      { importance: 8, monthlySales: 155, expected: 1.5 },
      { importance: 8, monthlySales: 156, expected: 1.5 },
      { importance: 8, monthlySales: 1757, expected: 1.5 },
      { importance: 12, monthlySales: 1000, expected: 1.5 },
    ];
    for (const c of cases) {
      const result = await db.query<{ days: string }>(
        `SELECT (${limitExpression})::text AS days
         FROM (SELECT $2::numeric AS monthly_sales) activity`,
        [c.importance, c.monthlySales],
      );
      assert.ok(
        Math.abs(Number(result.rows[0]?.days) - c.expected) < 0.000001,
        `importance=${c.importance}, monthlySales=${c.monthlySales}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("zero stock outside returns is excluded unless a newer card request exists", async () => {
  assert.match(settlementDuePredicate, /stats\.stock_without_returns/);
  assert.ok(settlementDuePredicate.includes("i.stocktake_required_at"));
  assert.ok(manualStocktakeRequestPredicate.includes("last_count.created_at IS NULL"));

  const db = new PGlite();
  try {
    const older = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const newer = new Date(Date.now() + 86_400_000).toISOString();
    const cases = [
      { description: "no balance and never adjusted", nonReturns: "0", showroom: "0", adjustment: null, elapsed: 0, requested: null, expected: false },
      { description: "only returns has stock, never adjusted", nonReturns: "0", showroom: "0", adjustment: null, elapsed: 0, requested: null, expected: false },
      { description: "zero non-returns stock after overdue adjustment", nonReturns: "0", showroom: "0", adjustment: older, elapsed: 12, requested: null, expected: false },
      { description: "zero net stock even with negative showroom", nonReturns: "0", showroom: "-2", adjustment: older, elapsed: 12, requested: null, expected: false },
      { description: "zero stock and manual request newer than last adjustment", nonReturns: "0", showroom: "0", adjustment: older, elapsed: 0, requested: newer, expected: true },
      { description: "zero stock and manual request older than last adjustment", nonReturns: "0", showroom: "0", adjustment: newer, elapsed: 0, requested: older, expected: false },
      { description: "zero stock, no adjustment, manual request", nonReturns: "0", showroom: "0", adjustment: null, elapsed: 0, requested: newer, expected: true },
      { description: "positive stock and never counted", nonReturns: "5", showroom: "5", adjustment: null, elapsed: 0, requested: null, expected: true },
      { description: "positive stock but last adjustment within 1.5 days", nonReturns: "5", showroom: "5", adjustment: older, elapsed: 1, requested: null, expected: false },
      { description: "positive stock due after periodic limit", nonReturns: "5", showroom: "5", adjustment: older, elapsed: 2, requested: null, expected: true },
      { description: "negative nonzero stock triggers stocktake", nonReturns: "-5", showroom: "-5", adjustment: newer, elapsed: 0, requested: null, expected: true },
    ];
    for (const c of cases) {
      const result = await db.query<{ due: boolean }>(
        `SELECT (${settlementDuePredicate}) AS due
        FROM (SELECT $1::timestamptz AS stocktake_required_at) i
        CROSS JOIN (SELECT
          $2::integer AS id,
          ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date - $3::integer) AS document_date,
          $4::timestamptz AS created_at
        ) last_count
        CROSS JOIN (SELECT $5::numeric AS stock_without_returns, $6::numeric AS stock_showroom) stats
        CROSS JOIN (SELECT $7::numeric AS raw_limit) count_limit`,
        [c.requested, c.adjustment === null ? null : 123, c.elapsed, c.adjustment, c.nonReturns, c.showroom, 1.5],
      );
      assert.equal(result.rows[0]?.due, c.expected, c.description);
    }
  } finally {
    await db.close();
  }
});
