import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { listMyCashboxTransfers } from "../apps/api/src/services/my-cashbox-transfers.ts";

type Statement = { sql: string; params: readonly unknown[] };
function mockClient(results: Array<{ rows: Record<string, unknown>[] }>) {
  const queries: Statement[] = [];
  return {
    queries,
    client: {
      async query(sql: string, params: readonly unknown[] = []) {
        queries.push({ sql, params });
        const answer = results.shift();
        if (!answer) throw new Error("Unexpected extra SQL query: " + sql);
        return answer;
      },
    } as unknown as PoolClient,
  };
}

test("both transfer kinds use rolling 24 hours and closings use rolling 14 hours", async () => {
  const now = new Date("2026-11-02T12:00:00.000Z");
  const records = mockClient([
    { rows: [{ id: 91 }] },
    { rows: [{ as_of: now }] },
    { rows: [
      { kind: "pouch", count: 3, total: "120.25" },
      { kind: "electronic", count: 1, total: "30" },
    ] },
    { rows: [
      { id: 10, kind: "pouch", amount: "120.25", notes: "إلى الحافظة", createdAt: now },
      { id: 11, kind: "electronic", amount: "30", notes: "", createdAt: now },
    ] },
    { rows: [{ count: 3, shortageTotal: "15", surplusTotal: "8" }] },
    { rows: [
      { id: 12, countedCash: "85", bookBalance: "100", difference: "15",
        shortage: "15", surplus: "0", notes: "", createdAt: now },
      { id: 13, countedCash: "108", bookBalance: "100", difference: "-8",
        shortage: "0", surplus: "8", notes: "", createdAt: now },
    ] },
  ]);
  const result = await listMyCashboxTransfers(records.client, 2, 77);
  assert.equal(result.hasEmployee, true);
  assert.equal(result.transferWindowStartAt, "2026-11-01T12:00:00.000Z");
  assert.equal(result.closingWindowStartAt, "2026-11-01T22:00:00.000Z");
  assert.equal(result.pouch.total, "120.25");
  assert.equal(result.electronic.total, "30");
  assert.equal(result.closings.count, 3);
  assert.equal(result.closings.shortageTotal, "15");
  assert.equal(result.closings.surplusTotal, "8");
  assert.equal(result.closings.items[1]?.difference, "-8");
  assert.equal(records.queries.length, 6);
  assert.deepEqual(records.queries[0]?.params, [2,77]);
  assert.deepEqual(records.queries[2]?.params,
    [2,91,"2026-11-01T12:00:00.000Z","2026-11-02T12:00:00.000Z"]);
  assert.deepEqual(records.queries[3]?.params, records.queries[2]?.params);
  assert.deepEqual(records.queries[4]?.params,
    [2,91,"2026-11-01T22:00:00.000Z","2026-11-02T12:00:00.000Z"]);
  assert.deepEqual(records.queries[5]?.params, records.queries[4]?.params);
  assert.match(records.queries[2]!.sql, /kind IN \('pouch','electronic'\)/);
  assert.match(records.queries[4]!.sql, /kind='close'/);
  assert.match(records.queries[4]!.sql, /sum\(GREATEST\(variance_amount,0\)\)/);
  assert.match(records.queries[4]!.sql, /sum\(GREATEST\(-variance_amount,0\)\)/);
  assert.doesNotMatch(records.queries[2]!.sql, /kind='close'/);
  assert.doesNotMatch(records.queries[2]!.sql, /last_closed|close_time|\$4::integer/i);
  assert.doesNotMatch(records.queries[3]!.sql, /kind='close'/);
});

test("employee identity is always resolved from authenticated user and company", async () => {
  const records = mockClient([{ rows: [] }]);
  const result = await listMyCashboxTransfers(records.client, 2, 77);
  assert.equal(result.hasEmployee, false);
  assert.equal(result.pouch.count, 0);
  assert.equal(result.electronic.count, 0);
  assert.equal(result.closings.count, 0);
  assert.equal(result.transferWindowStartAt, null);
  assert.equal(records.queries.length, 1);
  assert.deepEqual(records.queries[0]?.params, [2,77]);
});
