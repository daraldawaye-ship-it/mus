import assert from "node:assert/strict";
import { test } from "node:test";
import { pageByKey } from "../packages/contracts/src/pages.ts";
import { SETTLEMENT_FOLLOW_UP_SHORTCUT, withRequiredShortcuts } from "../apps/api/src/services/required-shortcuts.ts";

test("settlement shortcut points to the existing page, without creating a new permission", () => {
 const page=pageByKey(SETTLEMENT_FOLLOW_UP_SHORTCUT);
 assert.ok(page);
 assert.equal(page.route,"/companies/:companyId/settlement-follow-up");
 assert.equal(page.actions.view?.role,"permissions");
});
test("automatically append the shortcut for authorized company users", () => {
 const allow=new Set(["company.sales",SETTLEMENT_FOLLOW_UP_SHORTCUT,"company.purchases"]);
 assert.deepEqual(withRequiredShortcuts(["company.sales"],allow,2),
  ["company.sales",SETTLEMENT_FOLLOW_UP_SHORTCUT]);
 assert.deepEqual(withRequiredShortcuts([],allow,9),[SETTLEMENT_FOLLOW_UP_SHORTCUT]);
});
test("do not expose a shortcut with denied or disabled page access", () => {
 const allow=new Set(["company.sales"]);
 assert.deepEqual(withRequiredShortcuts(["company.sales",SETTLEMENT_FOLLOW_UP_SHORTCUT],allow,2),["company.sales"]);
 assert.deepEqual(withRequiredShortcuts([],allow,2),[]);
});
test("no company shortcut appears on the public site menu", () => {
 const allow=new Set(["public.pages",SETTLEMENT_FOLLOW_UP_SHORTCUT]);
 assert.deepEqual(withRequiredShortcuts(["public.pages"],allow,null),["public.pages"]);
});
test("preserve personal shortcuts, suppress duplicates and do not mutate saved preferences", () => {
 const allow=new Set(["company.sales","company.purchases",SETTLEMENT_FOLLOW_UP_SHORTCUT]);
 const saved=["company.purchases",SETTLEMENT_FOLLOW_UP_SHORTCUT,"company.sales",SETTLEMENT_FOLLOW_UP_SHORTCUT];
 const original=[...saved];
 assert.deepEqual(withRequiredShortcuts(saved,allow,2),
  ["company.purchases",SETTLEMENT_FOLLOW_UP_SHORTCUT,"company.sales"]);
 assert.deepEqual(saved,original);
});
