import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
  assert.match(worker,/alraesy-static-offline-20261030-v3/);
  assert.match(worker,/url\.pathname\.startsWith\("\/api\/"\)/);
});

test("worker refreshes only overview after upgrade, not unsaved invoice forms", () => {
  const worker=readFileSync("apps/web/public/push-sw.js","utf8");
  assert.doesNotMatch(worker,/client\.navigate\(url\.href\)/);
  assert.match(worker,/url\.pathname !== "\/"/);
  assert.match(worker,/companies/);
  assert.doesNotMatch(worker,/caches\.delete\(.*alraesy-device-v1/);
});
