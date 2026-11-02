import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Minimal event-driven IndexedDB emulator exercising real transaction completion
// rather than mocking the sales draft repository functions.
const records = new Map<string, Record<string, unknown>>();
const db = {
  createObjectStore() {
    return { createIndex() { return {}; } };
  },
  close() {},
  transaction(_name: string, _mode: string) {
    const tx: Record<string, unknown> = {oncomplete: null, onerror: null, onabort: null};
    const execute = (work: () => unknown) => {
      const request: Record<string, unknown> = {result: undefined, onsuccess: null, onerror: null};
      queueMicrotask(() => {
        request.result = work();
        (request.onsuccess as (() => void) | null)?.();
        (tx.oncomplete as (() => void) | null)?.();
      });
      return request;
    };
    tx.objectStore = () => ({
      put(row: Record<string, unknown>) {
        return execute(() => { records.set(row.key as string, structuredClone(row)); });
      },
      delete(key: string) {
        return execute(() => { records.delete(key); });
      },
      index() {
        return { getAll(owner: number[]) {
          return execute(() => [...records.values()].filter(row =>
            row.userId === owner[0] && row.companyId === owner[1]));
        } };
      },
    });
    return tx;
  },
};
(globalThis as {indexedDB?: unknown}).indexedDB = {
  open() {
    const request: Record<string, unknown> = {result: db, onupgradeneeded: null, onsuccess: null, onerror: null};
    queueMicrotask(() => {
      (request.onupgradeneeded as (() => void) | null)?.();
      (request.onsuccess as (() => void) | null)?.();
    });
    return request;
  },
};
const {
  saveSalesPointDraft, listSalesPointDrafts, deleteSalesPointDraft, flushSalesPointDrafts,
} = await import("../apps/web/src/sales-point-drafts.ts");

test("independent IndexedDB sales points survive listing, preserve identity, and never cross users or companies", async () => {
  const createdAt = "2026-11-02T00:00:00.000Z";
  const a = { lines: [{itemId: 11, quantity: "2"}], discount: "5" };
  const b = { lines: [{itemId: 22, quantity: "-1"}], discount: "-3" };
  await Promise.all([
    saveSalesPointDraft(101, 2, "one", createdAt, a),
    saveSalesPointDraft(101, 2, "two", "2026-11-02T00:00:01.000Z", b),
    saveSalesPointDraft(202, 2, "hidden", createdAt, {secret: "other user"}),
    saveSalesPointDraft(101, 3, "hidden-company", createdAt, {secret: "other company"}),
  ]);
  await flushSalesPointDrafts();
  const sales = await listSalesPointDrafts<typeof a>(101, 2);
  assert.deepEqual(sales.map(row => row.id), ["one", "two"]);
  assert.deepEqual(sales[0]?.form, a);
  assert.deepEqual(sales[1]?.form, b);
  assert.deepEqual((await listSalesPointDrafts(202,2)).map(row=>row.id), ["hidden"]);
  assert.equal((await listSalesPointDrafts(101,3)).length, 1);
  await saveSalesPointDraft(101, 2, "one", createdAt,
    {lines: [{itemId: 11, quantity: "9"}], discount: "0"});
  assert.equal((await listSalesPointDrafts<typeof a>(101,2))[0]?.form.lines[0]?.quantity, "9");
  await deleteSalesPointDraft(101,2,"one");
  assert.deepEqual((await listSalesPointDrafts(101,2)).map(row=>row.id), ["two"]);
  assert.equal((await listSalesPointDrafts(202,2)).length, 1);
});

test("sale editors restore before mounting, autosave changes, and clear a confirmed invoice", () => {
  const source = readFileSync(new URL("../apps/web/src/pages/CommercePages.tsx", import.meta.url), "utf8");
  assert.match(source, /listSalesPointDrafts<SalesPointForm>/);
  assert.match(source, /ready && points\.map/);
  assert.match(source, /saveSalesPointDraft\(user\.id, companyId, tabId/);
  assert.match(source, /deleteSalesPointDraft\(user\.id, companyId, tabId\)/);
  assert.match(source, /await flushSalesPointDrafts\(\)/);
  assert.match(source, /restored\?\.lines\?\.length/);
});
