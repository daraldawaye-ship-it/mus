import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
