import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  settlementDuePredicate,
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
