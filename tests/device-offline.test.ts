import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validOfflineSession, compareItemsBySavedSales } from "../apps/web/src/offline-storage.ts";

test("push worker never caches API requests", () => {
  const text=readFileSync("apps/web/public/push-sw.js","utf8");
  assert.match(text,/url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(text,/request\.method !== "GET"/);
  assert.doesNotMatch(text,/fetch\([^\n]+method:\s*["']POST/);
});

test("offline outbox only accepts finance docs, invoices and question answers", () => {
  const text=readFileSync("apps/web/src/offline-storage.ts","utf8");
  assert.match(text,/type OfflineKind = "invoice" \| "voucher" \| "answer"/);
  assert.doesNotMatch(text,/type OfflineKind[^\n]*"question"/);
  assert.match(text,/questions\\\/\\d\+\\\/answers/);
});

test("only confirmed server responses can post financial documents", () => {
  const finance=readFileSync("apps/web/src/pages/FinancePages.tsx","utf8");
  const commerce=readFileSync("apps/web/src/pages/CommercePages.tsx","utf8");
  assert.match(finance,/queueOfflineOperation/);
  assert.match(commerce,/queueOfflineOperation/);
  assert.match(finance,/محليًا فقط/);
  assert.match(commerce,/محاسبيًا أو مخزنيًا/);
});

test("browser shows no download controls and application detects its display mode", () => {
  const status=readFileSync("apps/web/src/OfflineStatus.tsx","utf8");
  const setup=readFileSync("apps/web/src/AppSetup.tsx","utf8");
  const install=readFileSync("apps/web/src/app-install.ts","utf8");
  assert.match(status,/if \(!isAppWindow\(\)\) return null;/);
  assert.match(status,/syncPending/);
  assert.match(status,/item-changes/);
  assert.match(setup,/<details className="app-install-guide">/);
  assert.match(setup,/<DevicePushBootstrap/);
  assert.match(install,/export const isAppWindow/);
  assert.match(install,/updateViaCache: "none"/);
});
test("new worker installation rotates only the static shell cache", () => {
  const worker=readFileSync("apps/web/public/push-sw.js","utf8");
  assert.match(worker,/alraesy-static-offline-20261030-v4/);
  assert.match(worker,/url\.pathname\.startsWith\("\/api\/"\)/);
});

test("worker refreshes only overview after upgrade, not unsaved invoice forms", () => {
  const worker=readFileSync("apps/web/public/push-sw.js","utf8");
  assert.doesNotMatch(worker,/client\.navigate\(url\.href\)/);
  assert.match(worker,/keys\.slice\(0,-3\)/);
  assert.doesNotMatch(worker,/caches\.delete\(.*alraesy-device-v1/);
});

test("invoice and work routes render before nonblocking device setup", () => {
  const app=readFileSync("apps/web/src/App.tsx","utf8");
  const setup=readFileSync("apps/web/src/AppSetup.tsx","utf8");
  const style=readFileSync("apps/web/src/styles.css","utf8");
  const main=app.indexOf('<main className="main-content"');
  const routes=app.indexOf("<Routes>",main);
  const endRoutes=app.indexOf("</Routes>",routes);
  const device=app.indexOf("<AppSetup",main);
  const endMain=app.indexOf("</main>",main);
  assert.ok(main>=0 && routes>main && endRoutes>routes);
  assert.ok(device>endRoutes && endMain>device,
    "Device download status must never reserve space above an invoice");
  assert.match(style,/\.app-device-setup:not\(:has\(/);
  assert.match(style,/display: none !important;/);
  assert.match(setup,/<OfflineStatus/);
  assert.match(setup,/<DevicePushBootstrap/);
  const status=readFileSync("apps/web/src/OfflineStatus.tsx","utf8");
  assert.match(status,/window\.setInterval\(resume, 120_000\)/);
  assert.match(status,/scheduleNextBatch/);
  assert.match(status,/return null;/);
});

test("only a recent unrevoked local identity can resume without network", () => {
  const now=Date.UTC(2026,9,30);
  const previous={user:{id:7,suspended:false,archived:false},savedAt:now-3600000};
  assert.equal(validOfflineSession(previous,now),true);
  assert.equal(validOfflineSession({...previous,savedAt:now-8*86400000},now),false);
  assert.equal(validOfflineSession({...previous,savedAt:now+1000},now),false);
  assert.equal(validOfflineSession({...previous,user:{...previous.user,suspended:true}},now),false);
  assert.equal(validOfflineSession({...previous,user:{...previous.user,archived:true}},now),false);
  assert.equal(validOfflineSession({...previous,user:{...previous.user,id:0}},now),false);
  assert.equal(validOfflineSession(null,now),false);
});

test("offline bootstrap never trusts a denied server session or caches credentials", () => {
  const api=readFileSync("apps/web/src/api.tsx","utf8");
  const store=readFileSync("apps/web/src/offline-storage.ts","utf8");
  const shared=readFileSync("apps/web/src/offline-shared.ts","utf8");
  assert.match(api,/readOfflineSession\(\)/);
  assert.match(api,/restoreOfflineSharedGrants\(user\.id\)/);
  assert.match(api,/error\.status === 401 \|\| error\.status === 403/);
  assert.match(api,/clearOfflineSession\(\)/);
  assert.match(api,/window\.addEventListener\("online", reconnect\)/);
  assert.match(store,/offline-session/);
  assert.match(store,/OFFLINE_SESSION_MAX_AGE_MS = 7/);
  assert.match(store,/page-catalog/);
  assert.doesNotMatch(store,/writeOne\("offline-session"[\s\S]{0,200}csrf:/);
  assert.match(shared,/grants\.clear\(\)/);
  assert.match(shared,/clearOfflineSharedGrants/);
});

test("offline navigation refreshes latest shell instead of serving old cached login", () => {
  const worker=readFileSync("apps/web/public/push-sw.js","utf8");
  assert.match(worker,/alraesy-static-offline-20261030-v4/);
  assert.match(worker,/fetch\(request, \{cache: "no-store"\}\)/);
  assert.match(worker,/shell\.put\("\/", response\.clone\(\)\)/);
  assert.match(worker,/shell\.match\("\/"\)/);
  assert.doesNotMatch(worker,/return await caches\.match\("\/"\)/);
  assert.match(worker,/url\.pathname\.startsWith\("\/api\/"\)/);
  assert.doesNotMatch(worker,/client\.navigate\(url\.href\)/);
});
test("offline identity is independent of catalog upgrade and recovers from outages", () => {
  const storage=readFileSync("apps/web/src/offline-storage.ts","utf8");
  const session=readFileSync("apps/web/src/api.tsx","utf8");
  assert.match(storage,/alraesy-offline-identity-v1/);
  assert.match(storage,/resumeDatabase/);
  assert.match(storage,/resumeWrite/);
  assert.match(storage,/resumeRead/);
  assert.match(storage,/resumeClear/);
  assert.match(session,/error\.status === 401 \|\| error\.status === 403/);
  assert.match(session,/error\.status >= 500/);
  assert.match(session,/restoreOfflineSharedGrants/);
});

test("offline question history is private to user/scope and refreshed after synchronization", () => {
  const storage=readFileSync("apps/web/src/offline-storage.ts","utf8");
  const page=readFileSync("apps/web/src/pages/QuestionsPage.tsx","utf8");
  const sync=readFileSync("apps/web/src/offline-my-history.ts","utf8");
  const routes=readFileSync("apps/api/src/routes-questions.ts","utf8");
  assert.match(storage,/personalAnswerHistory/);
  assert.match(storage,/activeUser !== userId/);
  assert.match(storage,/answerHistoryPath\(scope, questionId\)/);
  assert.match(storage,/rememberQuestionHistory/);
  assert.match(storage,/row\.kind === "answer"/);
  assert.match(page,/outcomeFor\(question/);
  assert.match(page,/personalAnswerHistory\(currentUser, scope\)/);
  assert.match(page,/storePersonalAnswer\(user\.id,scope/);
  assert.match(sync,/\/questions\/my-history/);
  assert.match(routes,/a\.user_id=\$1/);
  assert.match(routes,/latest/i);
});

test("offline appearance, page directory and top shortcuts use user-scoped caches", () => {
  const storage=readFileSync("apps/web/src/offline-storage.ts","utf8");
  const theme=readFileSync("apps/web/src/theme.tsx","utf8");
  const shortcuts=readFileSync("apps/web/src/UserShortcuts.tsx","utf8");
  const menu=readFileSync("apps/web/src/UserShortcutMenuGrid.tsx","utf8");
  const directory=readFileSync("apps/web/src/page-directory.tsx","utf8");
  assert.match(storage,/\/appearance/);
  assert.match(storage,/\/my-shortcuts/);
  assert.match(storage,/\/page-catalog/);
  assert.match(storage,/saveAppearanceDraft/);
  assert.match(storage,/readAppearanceDraft/);
  assert.match(theme,/readAppearanceDraft/);
  assert.match(theme,/clearAppearanceDraft/);
  assert.match(theme,/window\.addEventListener\("online",onOnline\)/);
  assert.match(shortcuts,/rememberRead\(url\(companyId\),updated\)/);
  assert.match(menu,/entry\.actionAccess\.view/);
  assert.match(directory,/actionAccess\.view/);
});

test("saved monthly sale frequency sorts offline item cards without re-reading invoices", () => {
  const month={ "11":"8","12":"3","13":"8","14":"-2" };
  const cards=[
    {id:12,code:"012",barcode:null},
    {id:14,code:"014",barcode:null},
    {id:13,code:"013",barcode:"EXACT"},
    {id:11,code:"011",barcode:null},
  ];
  assert.deepEqual([...cards].sort((a,b)=>
    compareItemsBySavedSales(a,b,month)).map(row=>row.id),[11,13,12,14]);
  assert.equal([...cards].sort((a,b)=>
    compareItemsBySavedSales(a,b,month,"EXACT"))[0]?.id,13);
  const snapshot=readFileSync("apps/web/src/offline-sale-rank-sync.ts","utf8");
  const local=readFileSync("apps/web/src/offline-shared-items.ts","utf8");
  const storage=readFileSync("apps/web/src/offline-storage.ts","utf8");
  const ui=readFileSync("apps/web/src/OfflineStatus.tsx","utf8");
  assert.match(snapshot,/if\(complete\?\.asOfDate===day\)return/);
  assert.match(snapshot,/saveSaleRankSnapshot/);
  assert.match(snapshot,/for\(let i=0;i<6/);
  assert.match(local,/readSaleRankSnapshot/);
  assert.match(storage,/activeUser!==userId/);
  assert.match(ui,/refreshDailySaleRanks/);
});

test("the default sales account uses only the logged in employee cashbox, including cached reads", () => {
  const storage=readFileSync("apps/web/src/offline-storage.ts","utf8");
  const cashbox=readFileSync("apps/web/src/employee-cashbox.ts","utf8");
  const editor=readFileSync("apps/web/src/pages/CommercePages.tsx","utf8");
  const ranking=readFileSync("apps/api/src/services/item-sale-ranking.ts","utf8");
  assert.match(storage,/my-sales-cashbox/);
  assert.match(cashbox,/employeeId/);
  assert.match(cashbox,/my-sales-cashbox/);
  assert.match(editor,/initialInvoiceAccount\(kind, defaultCashbox, configuredPurchaseAccount\)/);
  assert.match(editor,/accountManuallyChosen\.current/);
  assert.match(ranking,/page\.key==="company\.sales"/);
  assert.doesNotMatch(ranking,/\["company\.sales","company\.purchases","company\.invoice"\]/);
});
