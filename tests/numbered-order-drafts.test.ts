import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createNumberedOrderDraft, emptyOrderDraftState, migrateLegacyOrderDraft,
  normalizeOrderDrafts, removeNumberedOrderDraft, removeNumberedOrderDraftItem,
  MAX_NEW_ORDER_DRAFT_ITEMS, ORDER_DRAFT_LIFETIME_MS,
} from "../apps/web/src/numbered-order-drafts-core.ts";

const item = (id: number) => ({ id, name: `صنف ${id}`, code: String(id) });

test("each successful transfer creates a distinct numbered draft with global item uniqueness", () => {
  const one = createNumberedOrderDraft(emptyOrderDraftState(), [item(1),item(2),item(1)]);
  assert.equal(one.id, 1);
  assert.equal(one.added, 2);
  assert.equal(one.skipped, 1);
  assert.deepEqual(one.state.drafts.map(d => d.items.map(i => i.id)), [[1,2]]);

  const two = createNumberedOrderDraft(one.state, [item(2),item(3),item(3),item(4)]);
  assert.equal(two.id, 2);
  assert.equal(two.added, 2);
  assert.equal(two.skipped, 2);
  assert.deepEqual(two.state.drafts.map(d => d.items.map(i => i.id)), [[1,2],[3,4]]);

  const alreadyPresent = createNumberedOrderDraft(two.state, [item(1),item(2),item(3)]);
  assert.equal(alreadyPresent.id, null, "all duplicates must not create a new empty draft");
  assert.equal(alreadyPresent.added, 0);
  assert.equal(alreadyPresent.state.nextId, 3);
  const three = createNumberedOrderDraft(two.state, [item(5)]);
  assert.equal(three.id, 3);
});

test("deleting one draft releases its items but never changes another draft", () => {
  const first = createNumberedOrderDraft(emptyOrderDraftState(), [item(10),item(11)]).state;
  const second = createNumberedOrderDraft(first, [item(12)]).state;
  const removed = removeNumberedOrderDraft(second, 1);
  assert.deepEqual(removed.drafts.map(d=>d.id), [2]);
  assert.deepEqual(removed.drafts[0]?.items.map(i=>i.id), [12]);
  assert.equal(removed.nextId, 3, "draft number never reused after delete");
  const next = createNumberedOrderDraft(removed,[item(10),item(12)]);
  assert.equal(next.id, 3);
  assert.deepEqual(next.state.drafts[1]?.items.map(i=>i.id), [10]);
  assert.equal(next.skipped, 1);
  const edited = removeNumberedOrderDraftItem(next.state,2,12);
  assert.equal(edited.drafts[0]?.items.length,0);
  assert.deepEqual(edited.drafts[1]?.items.map(i=>i.id),[10]);
  const readded = createNumberedOrderDraft(edited, [item(12)]);
  assert.equal(readded.id,4);
});

test("migrates existing single browser order draft into draft 1 without loss", () => {
  const migrated = migrateLegacyOrderDraft([item(33),item(34),item(33)]);
  assert.equal(migrated.nextId, 2);
  assert.equal(migrated.drafts[0]?.id, 1);
  assert.deepEqual(migrated.drafts[0]?.items.map(i=>i.id), [33,34]);
  const created = createNumberedOrderDraft(migrated,[item(34),item(35)]);
  assert.equal(created.id,2);
  assert.deepEqual(created.state.drafts[0]?.items.map(i=>i.id), [33,34]);
  assert.deepEqual(created.state.drafts[1]?.items.map(i=>i.id), [35]);
  assert.deepEqual(migrateLegacyOrderDraft([]).drafts, []);
});

test("normalization repairs cross-draft duplicate IDs and keeps numbering monotonic", () => {
  const repaired = normalizeOrderDrafts({
    nextId: 9, drafts: [
      {id:1,items:[item(1),item(2)]},
      {id:3,items:[item(1),item(3)]},
      {id:3,items:[item(4)]},
    ],
  });
  assert.equal(repaired.nextId,9);
  assert.deepEqual(repaired.drafts.map(d=>d.items.map(i=>i.id)), [[1,2],[3]]);
  assert.deepEqual(normalizeOrderDrafts({nextId:1,drafts:[{id:7,items:[item(8)]}]}).nextId,8);
});

test("2000 is per new draft: overflow cannot partially change earlier drafts", () => {
  const first = createNumberedOrderDraft(emptyOrderDraftState(), [item(7)]).state;
  const batch = Array.from({length: MAX_NEW_ORDER_DRAFT_ITEMS},(_,index)=>item(index+100));
  const ok = createNumberedOrderDraft(first,batch);
  assert.equal(ok.id,2);
  assert.equal(ok.added,2000);
  const tooMany = createNumberedOrderDraft(first,[...batch,item(5000)]);
  assert.equal(tooMany.id,null);
  assert.match(tooMany.error ?? "",/2000/);
  assert.deepEqual(tooMany.state,first);
});

test("UI shows per-draft print, delete and migration, not a single global draft", () => {
  const page = readFileSync("apps/web/src/pages/ItemOptionsListPage.tsx","utf8");
  const store = readFileSync("apps/web/src/numbered-order-drafts.ts","utf8");
  assert.match(page,/useNumberedOrderDrafts/);
  assert.match(page,/temporaryOrder\.createDraft\(candidates\)/);
  assert.match(page,/temporaryOrder\.drafts\.map\(orderDraft/);
  assert.match(page,/temporaryOrder\.deleteDraft\(orderDraft\.id\)/);
  assert.match(page,/temporaryOrder\.removeItem\(orderDraft\.id, item\.id\)/);
  assert.match(page,/printSelection\(orderDraft\.id\)/);
  assert.match(page,/exportSelectionPdf\(orderDraft\.id\)/);
  assert.match(page,/مسودة الطلبية \$\{orderDraft\.id\}/);
  assert.doesNotMatch(page,/temporaryOrder\.addManyExact\(/);
  assert.match(store,/alraesy:temporary-items:v1:/);
  assert.match(store,/alraesy:order-drafts:v2:/);
  assert.match(store,/readOrderDrafts\(key, oldKey\)/);
  assert.match(store,/window\.localStorage\.setItem\(key, serialized\)/);
});


test("each order draft expires exactly eight hours after its own creation", () => {
  const start = Date.parse("2026-11-05T10:00:00.000Z");
  assert.equal(ORDER_DRAFT_LIFETIME_MS, 8 * 60 * 60 * 1000);
  const first = createNumberedOrderDraft(emptyOrderDraftState(), [item(1)], start);
  const later = createNumberedOrderDraft(first.state, [item(2)], start + 60_000);
  assert.equal(first.state.drafts[0].createdAt, new Date(start).toISOString());
  assert.equal(later.state.drafts[1].createdAt, new Date(start + 60_000).toISOString());
  const stillThere = normalizeOrderDrafts(later.state, start + ORDER_DRAFT_LIFETIME_MS - 1);
  assert.deepEqual(stillThere.drafts.map(d => d.id), [1,2]);
  const afterFirstExpires = normalizeOrderDrafts(later.state, start + ORDER_DRAFT_LIFETIME_MS);
  assert.deepEqual(afterFirstExpires.drafts.map(d => d.id), [2]);
  assert.equal(afterFirstExpires.nextId, 3);
  const afterBothExpire = normalizeOrderDrafts(later.state, start + ORDER_DRAFT_LIFETIME_MS + 60_000);
  assert.deepEqual(afterBothExpire.drafts, []);
  assert.equal(afterBothExpire.nextId, 3, "Never reuse old draft number");
  const newDraft = createNumberedOrderDraft(afterBothExpire, [item(1)], start + ORDER_DRAFT_LIFETIME_MS + 60_000);
  assert.equal(newDraft.id, 3);
  assert.equal(newDraft.added, 1, "Expired IDs become eligible for a new order");
});

test("unknown-age existing drafts receive a fresh, persisted eight-hour window", () => {
  const now = Date.parse("2026-11-05T10:00:00.000Z");
  const legacy = {nextId:4, drafts:[{id:3,items:[item(7)]}]};
  const migrated = normalizeOrderDrafts(legacy, now);
  assert.equal(migrated.drafts[0].createdAt, new Date(now).toISOString());
  assert.deepEqual(normalizeOrderDrafts(migrated, now + ORDER_DRAFT_LIFETIME_MS - 1).drafts.map(x=>x.id), [3]);
  assert.deepEqual(normalizeOrderDrafts(migrated, now + ORDER_DRAFT_LIFETIME_MS).drafts, []);
  const oldSingle = migrateLegacyOrderDraft([item(8)], now);
  assert.equal(oldSingle.drafts[0].createdAt,new Date(now).toISOString());
  assert.deepEqual(normalizeOrderDrafts(oldSingle, now + ORDER_DRAFT_LIFETIME_MS).drafts, []);
});

test("device-local draft hook persists expiry and handles sleeping tabs", () => {
  const hook = readFileSync("apps/web/src/numbered-order-drafts.ts", "utf8");
  assert.match(hook,/refreshOrderDrafts\(key, oldKey\)/);
  assert.match(hook,/window\.localStorage\.setItem\(key, serialized\)/);
  assert.match(hook,/Date\.parse\(draft\.createdAt\) \+ ORDER_DRAFT_LIFETIME_MS/);
  assert.match(hook,/window\.setTimeout/);
  assert.match(hook,/window\.setInterval\(refreshCurrent, 60_000\)/);
  assert.match(hook,/document\.addEventListener\("visibilitychange", onVisibility\)/);
  assert.match(hook,/window\.addEventListener\("focus", refreshCurrent\)/);
});
