import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("only fixed dock alternatives use the compact scroll table; safety warning and paging remain",()=>{
  const ui=read("apps/web/src/ItemMenuHistory.tsx");
  const table=ui.split("function WorkPanelAlternativesTable")[1].split("/** Reuses")[0];
  assert.match(table,/>الاسم<.*>الكمية</);
  assert.doesNotMatch(table,/peer\.code|الرصيد|smallestUnitName/);
  assert.match(table,/work-panel-movement-scroll work-panel-alternatives-scroll/);
  assert.match(table,/result.canViewStock && peer.stockAvailableSmallest != null/);
  assert.match(ui,/dockAlternatives = fixedView === "alternatives"/);
  assert.match(ui,/!dockAlternatives \|\| peers.relation !== "sameComposition"/);
  assert.match(ui,/تنبيه: غير قابلة للتبديل/);
  assert.match(ui,/page \* peers.pageSize < peers.total/);
  const css=read("apps/web/src/work-panel-alternatives.css");
  assert.match(css,/max-block-size: calc\(7 \* var\(--alternatives-row\)\)/);
  assert.match(css,/position: sticky/);
});
test("available quantity uses scoped showroom and warehouse with stock ACL and retains peer sort",()=>{
  const api=read("apps/api/src/services/item-composition-peers.ts");
  assert.match(api,/allowed\("company.stock-balances"\)&&allowed\("company.stock-movements"\)/);
  assert.match(api,/COALESCE\(s.stock_showroom,0\)\+COALESCE\(s.stock_warehouse,0\)/);
  assert.match(api,/NULL::text AS stock_available_smallest/);
  assert.match(api,/COALESCE\(s.stock_total,0\).*DESC[\s\S]+"i.code","i.id"/);
});
