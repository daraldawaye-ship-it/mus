import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = () => readFile(new URL("../apps/web/src/pages/ExpiryAlertFollowUpPage.tsx", import.meta.url), "utf8");

test("both expiry report modes share D13 with separately scoped visibility and layout", async () => {
  const page = await source();
  assert.match(page, /type Kind = "expired" \| "expiring-30"/);
  assert.match(page, /import InteractiveColumnsTable.*from "\.\.\/InteractiveColumnsTable"/);
  assert.match(page, /\<InteractiveColumnsTable<ExpiryItem, ColumnKey>/);
  assert.match(page, /const layoutScope=`\$\{user\?\.id\?\?"guest"\}:\$\{companyId\}:\$\{kind\}`/);
  assert.match(page, /<ExpiryTable key=\{layoutScope\}/);
  assert.match(page, /alraesy:expiry-follow-up-visible:v1:/);
  assert.match(page, /alraesy:expiry-follow-up-layout:v1:/);
  assert.match(page, /disabled=\{visible\.length === 1 && visible\.includes\(column\.key\)\}/);
  assert.doesNotMatch(page, /<table\b/);
});

test("keeps server pagination, sort, quantities, plain item labels and explicit lot links", async () => {
  const page = await source();
  assert.match(page, /q,sortBy,sortDir,page:String\(page\),pageSize:String\(pageSize\)/);
  assert.match(page, /"\/companies\/"\+companyId\+"\/expiry-alert-follow-up\/"\+kind/);
  assert.match(page, /sortDir:key===sortBy&&sortDir==="asc"\?"desc":"asc",page:""/);
  assert.match(page, /if \(key !== "details"\) onSort\(key\)/);
  assert.match(page, /rowKey = \(row: ExpiryItem\) => row\.itemId/);
  assert.match(page, /itemId: row\.itemId, itemName: row\.name/);
  assert.doesNotMatch(page, /\/items\/\$\{item\.itemId\}/);
  assert.match(page, /className="expiry-alert-item-name">\s*\{item\.name\}/);
  assert.match(page, /\/stock-balances\?view=lots&itemId=\$\{item\.itemId\}/);
  assert.match(page, /fmt\(item\.quantityUnit1\)/);
  assert.match(page, /<option value="20">20<\/option><option value="50">50<\/option><option value="100">100<\/option>/);
});
