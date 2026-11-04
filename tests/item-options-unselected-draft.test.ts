import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("add all unselected is based on full applied filters, never the 50 visible rows", () => {
  const page = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const body = page.slice(page.indexOf("async function addUnselectedToOrderDraft()"),
    page.indexOf("const change =", page.indexOf("async function addUnselectedToOrderDraft()")));
  assert.match(body, /new URLSearchParams\(request\)/);
  assert.match(body, /filters\.delete\("page"\)/);
  assert.match(body, /filters\.delete\("pageSize"\)/);
  assert.match(body, /item-options-list\/unselected/);
  assert.match(body, /temporaryOrder\.createDraft\(candidates\)/);
  assert.doesNotMatch(body, /result\.rows|temporarySelection\.items/);
  assert.match(page, /إضافة جميع الأصناف غير المختارة إلى مسودة طلبية/);
  assert.doesNotMatch(page, /onClick=\{addToOrderDraft\}/);
});

test("server excludes checkmarks within filtered query before limiting to 2000", () => {
  const api = read("apps/api/src/routes-item-options-list.ts");
  assert.match(api, /unselectedForDraft = false/);
  assert.match(api, /WHERE NOT EXISTS \(\s*SELECT 1 FROM company_item_temporary_selections chosen/);
  assert.match(api, /chosen\.company_id=\$1 AND chosen\.item_id=f\.id/);
  assert.match(api, /ORDER BY \$\{order\} LIMIT 2001/);
  assert.match(api, /rows\.length > 2000/);
  assert.match(api, /too_many_draft_items/);
  assert.match(api, /if \(!unselectedForDraft\)\s*values\.push\(options\.pageSize/);
  assert.match(api, /item-options-list\/unselected/);
  const route = api.slice(api.indexOf('router.get("/companies/:companyId/item-options-list/unselected"'),
    api.indexOf('router.get("/companies/:companyId/item-options-list",'));
  assert.match(route, /filteredItems\(client, actor\(req\), companyId, options, true\)/);
  assert.match(api, /canReadItemCoverage/);
  assert.match(api, /company\.item-options-list/);
});

test("local draft insertion is atomic if storage is full or fails", () => {
  const hook = read("apps/web/src/temporary-item-list.ts");
  const start = hook.indexOf("const addManyExact = useCallback");
  const end = hook.indexOf("const clear = useCallback", start);
  const block = hook.slice(start, end);
  assert.match(block, /next\.length >= MAX_ITEMS/);
  assert.match(block, /return false/);
  assert.ok(block.indexOf("next.length >= MAX_ITEMS") < block.indexOf("localStorage.setItem"));
  assert.match(block, /setItems\(next\)/);
  assert.match(block, /لم يُضف أي صنف/);
});
