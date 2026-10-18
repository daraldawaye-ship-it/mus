import test from "node:test";
import assert from "node:assert/strict";
import { pageKeyForLocation } from "../packages/contracts/src/pages.ts";
import { reportPrintLayout } from "../apps/web/src/reportPrintLayout.ts";

test("a pledged account statement prints its existing company header once", () => {
  const key = pageKeyForLocation(
    "/companies/2/account-ledger",
    "?accountId=17&pledge=1",
  );
  assert.equal(key, "company.account-ledger");
  assert.equal(reportPrintLayout(key), "own");
});

test("regular account statements use their own masthead, while other reports keep the general masthead", () => {
  assert.equal(
    reportPrintLayout(pageKeyForLocation("/companies/2/account-ledger", "?accountId=17")),
    "own",
  );
  assert.equal(reportPrintLayout("company.account-balances"), "generic");
  assert.equal(reportPrintLayout("company.memo-report"), "generic");
  assert.equal(reportPrintLayout("company.memos"), "none");
  assert.equal(reportPrintLayout(undefined), "none");
});
