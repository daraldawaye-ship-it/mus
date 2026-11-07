import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { auditActionLabels, companyAuditActions } from "../packages/contracts/src/index.ts";

const read = (path: string) => readFileSync(path, "utf8");

test("account ledger actions have dedicated company audit labels", () => {
  for (const event of ["accountLedger.view", "accountLedger.search", "accountLedger.select"] as const) {
    assert.ok(auditActionLabels[event], `missing audit label: ${event}`);
    assert.ok(companyAuditActions.includes(event), `missing company filter: ${event}`);
  }
});

test("ledger audit is authenticated and resolves account names within the company", () => {
  const api = read("apps/api/src/routes-finance.ts");
  assert.match(api, /ledgerActivityInput = z\.object/);
  assert.match(api, /z\.enum\(\["view", "search", "select"\]\)/);
  assert.match(api, /companyAccess\(client, user, companyId, "finance\.view"\)/);
  assert.match(api, /SELECT id,name,code FROM accounts WHERE company_id=\$1 AND id=\$2/);
  assert.match(api, /await audit\(\s*client, user,/);
  assert.match(api, /accountLedger\.search/);
  assert.match(api, /query: queryText \|\| null/);
  assert.doesNotMatch(api, /await audit\([\s\S]*?accountLedger\.search[\s\S]*?token_hash/);
});

test("ledger page records openings, debounced search and explicit account choice", () => {
  const page = read("apps/web/src/pages/FinancePages.tsx");
  const lookup = read("apps/web/src/phase2.tsx");
  assert.match(page, /didRecordLedgerVisit/);
  assert.match(page, /event: "view", accountId: accountId \|\| null/);
  assert.match(page, /queryText\.length < 3/);
  assert.match(page, /window\.setTimeout\(\(\) => \{/);
  assert.match(page, /event: "search", query: queryText\.slice\(0, 120\)/);
  assert.match(page, /event: "select", accountId: item\.id/);
  assert.match(lookup, /onSearchChange\?\.\(text\)/);
  assert.match(lookup, /onSelect\?\.\(next, query\)/);
});
