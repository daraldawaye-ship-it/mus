import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const report = readFileSync("apps/web/src/pages/SettlementFollowUpPage.tsx", "utf8");
const sheet = readFileSync("apps/web/src/pages/InventoryPages.tsx", "utf8");
const route = readFileSync("apps/api/src/routes-settlement-follow-up.ts", "utf8");
const adjustment = readFileSync("apps/api/src/routes-inventory.ts", "utf8");
const pageDef = readFileSync("packages/contracts/src/pages.ts", "utf8");
const reg = readFileSync("apps/api/migrations/20261102_register_settlement_followup.sql", "utf8");
const rewards = readFileSync("apps/api/src/services/stock-count-rewards.ts", "utf8");

test("default list is due items, explicit dueOnly=0 shows all", () => {
  assert.match(report, /const dueOnly = params\.get\("dueOnly"\) !== "0"/);
  assert.match(report, /if \(checked\) next\.delete\("dueOnly"\)/);
  assert.match(report, /else next\.set\("dueOnly", "0"\)/);
  assert.match(route, /const dueOnly = req\.query\.dueOnly === "1"/);
});
test("settlement button opens preselected item's existing modal", () => {
  assert.match(report, /header: "تسوية"/);
  assert.match(report, /setSelectedItemId\(row\.original\.id\)/);
  assert.match(report, /api<\{ item: Item \}>\(/);
  assert.match(report, /<InventoryAdjustmentSheet/);
  assert.match(report, /fromRequiredPage/);
  assert.match(report, /onSaved=\{\(\) => \{ void list\.refetch\(\); \}\}/);
  assert.match(sheet, /fromRequiredPage\?: boolean/);
  assert.match(sheet, /const fromRequiredTask = fromRequiredPage \|\|/);
});
test("report grants are separate from stock and finance posting rights", () => {
  assert.match(route, /company\.settlement-follow-up/);
  assert.doesNotMatch(route, /for \(const key of \["company\.sales"/);
  assert.match(pageDef, /"company\.settlement-follow-up"/);
  assert.match(reg, /INSERT INTO page_registry\(key\)/);
  assert.match(reg, /company\.settlement-follow-up/);
  assert.match(report, /context\.permissions\.includes\("inventory.post"\)/);
  assert.match(report, /context\.permissions\.includes\("finance.post"\)/);
});
test("award uses existing configurable task, once per qualifying due operation", () => {
  assert.match(adjustment, /const fromRequiredTask = req\.query\.taskSource === "required-count"/);
  assert.match(adjustment, /eligibleForTask = fromRequiredTask && eligibleForReward/);
  assert.match(adjustment, /if \(eligibleForTask\)\s+await awardRequiredStockCount/);
  assert.match(rewards, /s\.code='STOCK_COUNT_REQUIRED'/);
  assert.match(rewards, /s\.points::text AS points/);
  assert.match(rewards, /ON CONFLICT DO NOTHING RETURNING id/);
});

test("page permission writes automatically register only validated page keys before grants", () => {
  const route = readFileSync("apps/api/src/routes-pages.ts","utf8");
  const i = route.indexOf("router.put(\"/page-catalog/:pageKey/grants\"");
  assert.ok(i > 0);
  const code = route.slice(i, route.indexOf("router.put(", i + 12));
  assert.match(code,/const key=String\(req\.params\.pageKey\),definition=pageByKey\(key\)/);
  assert.match(code,/if\(!definition\)missing\(\)/);
  const register=code.indexOf("INSERT INTO page_registry(key)");
  const grant=code.indexOf("INSERT INTO page_access_grants(page_key");
  assert.ok(register > 0 && grant > register, "page FK must be populated before inserting grants");
});
