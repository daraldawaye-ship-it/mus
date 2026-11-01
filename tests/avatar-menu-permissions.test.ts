import assert from "node:assert/strict";
import test from "node:test";
import { allowedAvatarTabs } from "../apps/web/src/avatar-menu-permissions.ts";

const page = (key: string, view = true, enabled = true) =>
  ({ key, enabled, actionAccess: { view } });

test("owner keeps every avatar tab even on a public page", () => {
  assert.deepEqual(allowedAvatarTabs(true, null, undefined),
    ["navigation", "item", "financialAccount", "employee", "tools", "settings"]);
});

test("users without an active company retain only personal safe tabs", () => {
  assert.deepEqual(allowedAvatarTabs(false, null, undefined), ["navigation", "settings"]);
  assert.deepEqual(allowedAvatarTabs(false, 12, undefined), ["navigation", "tools", "settings"]);
  assert.deepEqual(allowedAvatarTabs(false, 12, [page("company.items", false)]),
    ["navigation", "tools", "settings"]);
});

test("read-only item access shows item tab, not accounts, staff or admin tools", () => {
  assert.deepEqual(allowedAvatarTabs(false, 12, [
    page("company.items"), page("company.employees", false),
    page("company.financial-documents", false),
  ]), ["navigation", "item", "tools", "settings"]);
});

test("accounts.view alone enables account lookup without finance posting rights", () => {
  assert.deepEqual(allowedAvatarTabs(false, 12, [page("company.accounts")]),
    ["navigation", "financialAccount", "tools", "settings"]);
});

test("finance, employees and permission administrators see their own tabs", () => {
  assert.deepEqual(allowedAvatarTabs(false, 12, [
    page("company.account-ledger"), page("company.employees"),
    page("company.configuration"),
  ]), ["navigation", "financialAccount", "employee", "tools", "settings"]);
});

test("disabled page access never grants a tab and invoice/stock access can grant item", () => {
  assert.deepEqual(allowedAvatarTabs(false, 12, [
    page("company.items", true, false), page("company.purchases", false),
    page("company.stock-movements"), page("company.configuration", true, false),
  ]), ["navigation", "item", "tools", "settings"]);
});

test("visible tabs follow the fixed top-bar order even with mixed permissions", () => {
  const actual = allowedAvatarTabs(false, 12, [
    page("company.employees"), page("company.purchases"),
    page("company.financial-documents"),
  ]);
  assert.deepEqual(actual,
    ["navigation", "item", "financialAccount", "employee", "tools", "settings"]);
});

test("global last-present page grant, but not an unrelated public page, exposes Other", () => {
  assert.deepEqual(allowedAvatarTabs(false, null, [page("public.last-present")]),
    ["navigation", "tools", "settings"]);
  assert.deepEqual(allowedAvatarTabs(false, null, [page("public.last-present", false)]),
    ["navigation", "settings"]);
});
