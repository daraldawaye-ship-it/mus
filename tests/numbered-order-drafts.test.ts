import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildReplacementOrderDrafts, createNumberedOrderDraft, emptyOrderDraftState, migrateLegacyOrderDraft,
  normalizeOrderDrafts, removeNumberedOrderDraft, removeNumberedOrderDraftItem,
  setOrderDraftItemDeleted, setOrderDraftItemQuantity,
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
  assert.match(page,/temporaryOrder\.createDraft\(candidates, optionName\)/);
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


test("new order drafts retain the exact required quantity from the item-options column", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  const chosen = { ...item(42), requiredQuantity: "24" };
  const second = { ...item(43), requiredQuantity: "5" };
  const created = createNumberedOrderDraft(emptyOrderDraftState(), [chosen,second], now);
  assert.deepEqual(created.state.drafts[0].items, [chosen,second]);
  const loaded = normalizeOrderDrafts(JSON.parse(JSON.stringify(created.state)), now + 60_000);
  assert.deepEqual(loaded.drafts[0].items, [chosen,second],
    "Normalization must not strip the quantity before printing or exporting PDF");
  const withoutQuantity = createNumberedOrderDraft(emptyOrderDraftState(), [item(7)], now);
  assert.equal("requiredQuantity" in withoutQuantity.state.drafts[0].items[0], false,
    "An old name-only draft remains blank instead of inventing a required quantity");
  const malformed = normalizeOrderDrafts({
    nextId: 2, drafts: [{ id: 1, createdAt: new Date(now).toISOString(),
      items: [{ ...item(9), requiredQuantity: "-10" }] }],
  }, now + 1);
  assert.equal(malformed.drafts[0].items[0].requiredQuantity, undefined);
  const withDuplicate = createNumberedOrderDraft(created.state,
    [{ ...item(42), requiredQuantity:"200" }, {...item(44),requiredQuantity:"3"}], now + 1);
  assert.equal(withDuplicate.skipped,1);
  assert.equal(withDuplicate.state.drafts[0].items[0].requiredQuantity,"24",
    "Importing another draft must not change a previously saved planned order");
  assert.equal(withDuplicate.state.drafts[1].items[0].requiredQuantity,"3");
});


test("draft header displays exact purchase value after item count, grouped by currency", () => {
  const page = readFileSync("apps/web/src/pages/ItemOptionsListPage.tsx", "utf8");
  const route = readFileSync("apps/api/src/routes-item-options-list.ts", "utf8");
  assert.match(page, /مسودة الطلبية \$\{orderDraft\.id\} \(\$\{orderDraft\.items\.length\.toLocaleString\("en-US"\)\} صنف\)/);
  const indexCount = page.indexOf('مسودة الطلبية ${orderDraft.id} (${orderDraft.items.length.toLocaleString("en-US")} صنف)');
  const indexValue = page.indexOf('{" — قيمة المطلوب: "}');
  assert.ok(indexCount >= 0 && indexValue > indexCount && indexValue - indexCount < 250);
  assert.match(page, /draftValueById\.get\(orderDraft\.id\)/);
  assert.match(page, /formatAmountGroup\(total\.value\)\} \{total\.currencyCode\}/);
  assert.match(page, /missingCount > 0/);
  assert.match(page, /requiredQuantity:item\.requiredQuantity \?\? null/);
  assert.match(page, /item-options-list\/draft-values/);
  assert.match(route, /router\.post\("\/companies\/:companyId\/item-options-list\/draft-values"/);
  assert.match(route, /readItems\(pool, req, async \(client, companyId\)/);
  const draftValueRoute = route.slice(route.indexOf(
    'router.post("/companies/:companyId/item-options-list/draft-values"'),
    route.indexOf("router.get(presetsPath"));
  assert.match(draftValueRoute, /currentActor\(client, actor\(req\), false\)/,
    "must not use SELECT FOR UPDATE in a repeatable-read read-only transaction");
  assert.doesNotMatch(draftValueRoute, /ORDER_DRAFT_VALUE_FAILURE|ORDER_DRAFT_VALUE_QUERY_FAILURE/);
  assert.match(route, /i\.company_id=\$1 AND i\.id=requested\.item_id/);
  assert.match(route, /SUM\(ROUND\(i\.purchase_price::numeric \* requested\.required_quantity,4\)\)::text/);
  assert.match(route, /GROUP BY requested\.draft_id,currency\.code/);
  assert.match(route, /missingCount: draft\.itemCount - draft\.pricedCount/);
  assert.match(route, /res\.setHeader\("Cache-Control", "private, no-store"\)/);
  // Existing local drafts, even those created before the feature, are valued
  // using their saved quantities and CURRENT first-unit purchase prices.
  assert.match(route, /requiredQuantity: z\.string\(\)\.regex\(/);
  assert.match(page, /إجمالي قيمة المطلوب|قيمة المطلوب/);
});

test("saved ordered option groups replace device drafts atomically in priority order", () => {
  // Source 1 wins duplicates; later sources keep only previously unseen items.
  const incoming = [
    [item(10),item(20),item(30)],
    [item(20),item(40)],
    [item(10),item(40),item(50)],
  ];
  const built=buildReplacementOrderDrafts(incoming, Date.parse("2026-11-09T09:00:00Z"));
  assert.equal(built.error,null);
  assert.equal(built.added,5);
  assert.equal(built.skipped,3);
  assert.deepEqual(built.state?.drafts.map(d=>d.id),[1,2,3]);
  assert.deepEqual(built.state?.drafts.map(d=>d.items.map(x=>x.id)),[[10,20,30],[40],[50]]);
  assert.equal(built.state?.nextId,4);
  const allIds=built.state!.drafts.flatMap(d=>d.items.map(x=>x.id));
  assert.equal(new Set(allIds).size,allIds.length);
});
test("group preparation errors or no matching items never replace previous drafts", () => {
  assert.equal(buildReplacementOrderDrafts([[],[]]).state,null);
  assert.match(buildReplacementOrderDrafts([[],[]]).error!,/لا توجد أصناف/);
  assert.equal(buildReplacementOrderDrafts([]).state,null);
  assert.equal(buildReplacementOrderDrafts(Array.from({length:21},()=>[item(1)])).state,null);
  const tooMany=buildReplacementOrderDrafts([Array.from({length:2001},(_,i)=>item(i+1))]);
  assert.equal(tooMany.state,null);
  assert.match(tooMany.error!,/2000/);
});
test("named preset groups are server-saved; one successful browser write replaces drafts", () => {
  const page=readFileSync("apps/web/src/pages/ItemOptionsListPage.tsx","utf8");
  const server=readFileSync("apps/api/src/routes-item-options-list.ts","utf8");
  const local=readFileSync("apps/web/src/numbered-order-drafts.ts","utf8");
  const migration=readFileSync("apps/api/migrations/20261109_company_item_options_preset_groups.sql","utf8");
  assert.match(page,/تجميع الخيارات المحفوظة بالترتيب/);
  assert.match(page,/moveGroupStep\(index,-1\)/);
  assert.match(page,/moveGroupStep\(index,1\)/);
  assert.match(page,/void runPresetGroup\(chosen\)/);
  assert.match(page,/replaceFromPresetGroup\(/);
  assert.match(page,/stages\.map\(stage=>stage\.name\)/);
  assert.match(server,/router\.post\(\`\$\{presetGroupsPath\}\/\:groupId\/prepare\`/);
  assert.match(server,/const excludedIds=new Set<number>\(\)/);
  assert.match(server,/for\(const item of items\) excludedIds\.add\(item\.id\)/);
  assert.match(server,/includeSharedSelectionsForDraft \? ""/);
  assert.match(migration,/preset_ids BIGINT\[\] NOT NULL/);
  assert.match(local,/const built=buildReplacementOrderDrafts\(stages,Date\.now\(\),sourceOptionNames\)/);
  assert.match(local,/if\(!save\(built\.state\)\) return null/);
  assert.doesNotMatch(page,/temporaryOrder\.drafts\.forEach\(.*deleteDraft/);
});

test("order draft tracks option provenance, quantity edits and reversible deletion", () => {
  const start=Date.parse("2026-11-09T10:00:00Z");
  const created=createNumberedOrderDraft(emptyOrderDraftState(),[
    {...item(20),requiredQuantity:"24"}, {...item(21),requiredQuantity:"7"},
  ],start,"نواقص سريعة");
  assert.equal(created.state.drafts[0]?.sourceOptionName,"نواقص سريعة");
  assert.deepEqual(created.state.drafts[0]?.items.map(i=>i.sourceOptionName),
    ["نواقص سريعة","نواقص سريعة"]);
  const adjusted=setOrderDraftItemQuantity(created.state,1,20,"36");
  assert.equal(adjusted.drafts[0]?.items[0]?.requiredQuantity,"36");
  const invalid=setOrderDraftItemQuantity(adjusted,1,20,"-2");
  assert.deepEqual(invalid,adjusted,"nonpositive quantities cannot replace saved values");
  const deleted=setOrderDraftItemDeleted(adjusted,1,20,true);
  assert.equal(deleted.drafts[0]?.items[0]?.deleted,true);
  assert.equal(deleted.drafts[0]?.items.length,2,"soft deletion must retain the record");
  const reloaded=normalizeOrderDrafts(JSON.parse(JSON.stringify(deleted)),start+1);
  assert.equal(reloaded.drafts[0]?.items[0]?.deleted,true);
  assert.equal(reloaded.drafts[0]?.items[0]?.sourceOptionName,"نواقص سريعة");
  assert.equal(reloaded.drafts[0]?.items[0]?.requiredQuantity,"36");
  const duplicate=createNumberedOrderDraft(reloaded,[item(20),item(22)],start+1);
  assert.equal(duplicate.added,1,"deleted rows still reserve their ID for undo");
  const restored=setOrderDraftItemDeleted(reloaded,1,20,false);
  assert.equal(restored.drafts[0]?.items[0]?.deleted,undefined);
  assert.equal(restored.drafts[0]?.items[0]?.requiredQuantity,"36");
});

test("ordered preset-group stages keep the exact source option name per draft",()=>{
  const start=Date.parse("2026-11-09T10:00:00Z");
  const built=buildReplacementOrderDrafts([
    [{...item(1),requiredQuantity:"2"}],[{...item(2),requiredQuantity:"3"}],
  ],start,["خيارات أولى","خيارات ثانية"]);
  assert.equal(built.state?.drafts[0]?.sourceOptionName,"خيارات أولى");
  assert.equal(built.state?.drafts[1]?.items[0]?.sourceOptionName,"خيارات ثانية");
  assert.equal(normalizeOrderDrafts(built.state,start+1).drafts[1].items[0].sourceOptionName,
    "خيارات ثانية");
});

test("new draft-review route and UI share item-list authorization and preserve deleted rows",()=>{
  const app=readFileSync("apps/web/src/App.tsx","utf8");
  const page=readFileSync("apps/web/src/pages/ItemOrderDraftsPage.tsx","utf8");
  const source=readFileSync("apps/web/src/pages/ItemOptionsListPage.tsx","utf8");
  const hook=readFileSync("apps/web/src/numbered-order-drafts.ts","utf8");
  assert.match(app,/"item-order-drafts"/);
  assert.match(app,/section === "item-order-drafts" \? "company.item-options-list"/);
  assert.match(page,/useNumberedOrderDrafts/);
  assert.match(page,/updateItemQuantity/);
  assert.match(page,/إرجاع الحذف/);
  assert.match(page,/اسم الخيارات/);
  assert.match(source,/item-order-drafts/);
  assert.match(source,/filter\(item => !item.deleted\)/);
  assert.match(hook,/setOrderDraftItemDeleted/);
  assert.match(hook,/setOrderDraftItemQuantity/);
});
