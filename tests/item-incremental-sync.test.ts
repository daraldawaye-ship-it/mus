import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sanitizeSharedReference } from "../apps/web/src/offline-shared.ts";

test("item delta route checks company permissions, bounds pages and uses precise cursor", () => {
  const source = readFileSync("apps/api/src/routes-commerce-options.ts", "utf8");
  assert.match(source, /"\/companies\/:companyId\/item-changes"/);
  assert.match(source, /companyAccess\(client, user, companyId, permission\)/);
  assert.match(source, /LIMIT 101/);
  assert.match(source, /\.updated_at,i\.id/);
  assert.match(source, /HH24:MI:SS\.US/);
});
test("item deltas persist per user/company and keep offline outbox unchanged", () => {
  const storage = readFileSync("apps/web/src/offline-storage.ts", "utf8");
  const status = readFileSync("apps/web/src/OfflineStatus.tsx", "utf8");
  assert.match(storage, /item-sync/);
  assert.match(storage, /applyItemChanges/);
  assert.match(storage, /"invoice" \| "voucher" \| "answer"/);
  assert.match(status, /120_000/);
  assert.doesNotMatch(status, /setInterval\(connected, 20_000\)/);
  assert.match(status, /alraesy-invoice-reset/);
  assert.match(status, /repeatAfterCurrent/);
  assert.match(status, /visibilitychange/);
  const commerce = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  assert.match(commerce, /new CustomEvent\("alraesy-invoice-reset"/);
  assert.match(commerce, /function resetInvoice\(\)/);
});


test("device setup has one active offline panel and a resumable lightweight catalog", () => {
  const ui = readFileSync("apps/web/src/OfflineStatus.tsx", "utf8");
  const storage = readFileSync("apps/web/src/offline-storage.ts", "utf8");
  const styles = readFileSync("apps/web/src/styles.css", "utf8");
  assert.match(ui, /data-alraesy-offline-instance/);
  assert.match(ui, /primary && <OfflineStatusBody/);
  assert.match(ui, /activeCatalogDownload/);
  assert.match(ui, /saveSharedItemBatch/);
  assert.match(ui, /readSharedItemProgress/);
  assert.match(ui, /downloadSharedReferenceCards/);
  assert.match(ui, /"\/companies\/".*?"\/item-changes\?"/s);
  assert.match(storage, /"catalog-download"/);
  assert.match(storage, /writeCatalog\(entries\)/);
  assert.match(styles, /\.app-device-setup:has\(~ \.app-device-setup\)/);
});


test("only one device setup remains visible even when legacy mounts are in separate wrappers", () => {
  const setup = readFileSync("apps/web/src/AppSetup.tsx", "utf8");
  const status = readFileSync("apps/web/src/OfflineStatus.tsx", "utf8");
  assert.match(setup, /document\.querySelectorAll<HTMLElement>\("\.app-device-setup"\)/);
  assert.match(setup, /panel\.style\.setProperty\("display", "none", "important"\)/);
  assert.match(setup, /panel\.dataset\.alraesySetup === "current"/);
  assert.match(setup, /observer\.observe\(document\.body/);
  assert.match(status, /observer\.observe\(document\.body/);
});

test("shared references are company-scoped and permission gated on every login", () => {
  const cache=readFileSync("apps/web/src/offline-shared.ts","utf8");
  const api=readFileSync("apps/web/src/api.tsx","utf8");
  const items=readFileSync("apps/web/src/offline-shared-items.ts","utf8");
  const downloader=readFileSync("apps/web/src/offline-shared-master.ts","utf8");
  assert.match(cache,/grants\.clear\(\)/);
  assert.match(cache,/sharedIdentity/);
  assert.match(cache,/sharedProgress/);
  assert.doesNotMatch(cache,/correctAnswer:item\.correctAnswer/);
  assert.doesNotMatch(cache,/myLastSelectedAnswer:item\.myLastSelectedAnswer/);
  assert.doesNotMatch(cache,/myLastSelectedAnswer:item\.myLastSelectedAnswer/);
  assert.match(cache,/accountChoice:item\.accountChoice/);
  assert.doesNotMatch(cache,/ownerPhone:item\.ownerPhone/);
  assert.match(api,/shareAuthorizedRead\(path, data\)/);
  assert.match(api,/reuseAuthorizedRead<T>\(path\)/);
  assert.match(items,/sharedItemsAllowed\(companyId,userId\)/);
  assert.match(items,/"items:"\+companyId/);
  assert.match(downloader,/sharedProgress\(companyId,group,userId\)/);
});

test("shared snapshots remove personal question answers and financial balances", () => {
  const question=sanitizeSharedReference("/companies/2/questions?page=1",{
    total:1,items:[{id:1,question:"اختبار",options:["أ","ب"],
      correctAnswer:2,myLastSelectedAnswer:1,myLastPoints:50,
      myAnswerCount:2,points:5}],
  }) as {items:Record<string,unknown>[]};
  assert.equal(question.items[0].question,"اختبار");
  assert.equal(question.items[0].correctAnswer,undefined);
  assert.equal(question.items[0].myLastSelectedAnswer,undefined);
  assert.equal(question.items[0].myLastPoints,undefined);
  const account=sanitizeSharedReference("/companies/2/commerce-options?type=accounts",{
    items:[{id:22,code:"100",name:"العملاء",balance:"999999",
      ownerPhone:"777777",privacyLevel:4,accountLimit:"10000"}],
  }) as {items:Record<string,unknown>[]};
  assert.deepEqual(account.items[0],{
    id:22,companyId:undefined,code:"100",name:"العملاء",
    parentId:undefined,kind:undefined,category:undefined,
    active:undefined,accountChoice:undefined,
  });
});
