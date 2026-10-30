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


test("device setup has one active offline panel and a resumable lightweight catalog", () => {
  const ui = readFileSync("apps/web/src/OfflineStatus.tsx", "utf8");
  const storage = readFileSync("apps/web/src/offline-storage.ts", "utf8");
  const styles = readFileSync("apps/web/src/styles.css", "utf8");
  assert.match(ui, /data-alraesy-offline-instance/);
  assert.match(ui, /primary && <OfflineStatusBody/);
  assert.match(ui, /activeCatalogDownload/);
  assert.match(ui, /rememberCatalogBatch/);
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
