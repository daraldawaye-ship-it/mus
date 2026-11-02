import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { memoCreateSchema, memoTypeLabels, memoTypeSchema } from "../packages/contracts/src/memos.ts";

const code = (path: string) => readFileSync(path,"utf8");

test("avatar item action grid retains historic choices and adds four direct item actions",() => {
  const ui = code("apps/web/src/ItemMenuHistory.tsx");
  for(const text of ["مشتريات","مبيعات","تسويات","مناقلات","البدائل","كرت الصنف",
    "تسوية الصنف","مناقلة الصنف","إرسال مذكرة بالصنف","إرسال مذكرة مرتجع"]) {
    assert.ok(ui.includes(text), "Missing item action: " + text);
  }
  assert.match(ui,/disabled=\{!itemId \|\| \(key\.startsWith\("memo"\) && !canCreateMemo\)\}/);
  assert.match(ui,/onQuickAction\(key,itemId,itemName/);
});

test("settlements and transfers open the selected item using existing role-gated sheets", () => {
  const userMenu=code("apps/web/src/UserMenu.tsx");
  const host=code("apps/web/src/ItemQuickInventorySheetHost.tsx");
  const app=code("apps/web/src/App.tsx");
  assert.match(userMenu,/openItemInventorySheet\(companyId, itemId, action\)/);
  assert.match(userMenu,/dismiss\(\)/);
  assert.match(app,/<ItemQuickInventorySheetHost context=\{navigationContext\} \/>/);
  assert.match(host,/\/companies\/\$\{companyId\}\/items\/\$\{selected!\.itemId\}/);
  assert.match(host,/InventoryAdjustmentSheet/);
  assert.match(host,/InventoryTransferSheet/);
  assert.match(host,/selected\.companyId !== companyId/);
  assert.match(host,/item\.data\.item/);
  assert.doesNotMatch(host,/stock-transfers.*method:"POST"|stock-adjustments.*method:"POST"/s);
});

test("new return memo type is real, linked to item, and recipient is still mandatory", () => {
  assert.equal(memoTypeSchema.parse("item_return"), "item_return");
  assert.equal(memoTypeLabels.item_return, "إرجاع صنف");
  const valid = memoCreateSchema.safeParse({
    title:"إرجاع صنف: مثال",body:"يرجى إرجاع الصنف",
    type:"item_return",recipientEmployeeId:1,
    idempotencyKey:"00000000-0000-4000-8000-000000000001",
    links:{followPage:null,referencePage:null,itemId:123,accountId:null},
  });
  assert.equal(valid.success,true,valid.success ? "" : valid.error.message);
  assert.equal(memoCreateSchema.safeParse({
    title:"إرجاع صنف: مثال",body:"يرجى إرجاع الصنف",type:"item_return",
    idempotencyKey:"00000000-0000-4000-8000-000000000001",
  }).success,false,"Memo must keep required recipient");
  const sql = code("apps/api/migrations/175_item_return_memo_type.sql");
  assert.match(sql,/ADD CONSTRAINT memos_type_check/);
  assert.match(sql,/item_return/);
  const memoPage=code("apps/web/src/pages/MemosPage.tsx");
  assert.match(memoPage,/memoIntent === "return"/);
  assert.match(memoPage,/setType\("item_return"\)/);
  assert.match(memoPage,/setLinks\(\{ \.\.\.emptyMemoLinks\(\), itemId: Number\(rawItem\) \}\)/);
  assert.match(memoPage,/recipientEmployeeId: recipient!\.id/);
  const menu=code("apps/web/src/UserMenu.tsx");
  assert.match(menu,/itemMemo: action === "memo-return" \? "return" : "item"/);
  assert.match(menu,/if \(!canCreateMemo\) return/);
});
