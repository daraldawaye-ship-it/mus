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
