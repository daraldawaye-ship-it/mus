import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const src=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("only the WorkPanel mode asks for monthly sales and renders the column in its scroll",()=>{
  const ui=src("apps/web/src/ItemMenuHistory.tsx");
  const routes=src("apps/api/src/routes-items.ts");
  const table=ui.split("function WorkPanelAlternativesTable")[1].split("/** Reuses")[0];
  assert.match(table,/>الاسم<.*>الكمية<.*>المباع في شهر</);
  assert.match(table,/result.canViewMonthlySales\?formatStockSaleQuantity\(peer.saleQuantityMonth\)/);
  assert.match(ui,/fixedView==="alternatives"\?"&workPanel=1":""/);
  assert.match(routes,/dockRaw!==undefined && dockRaw!=="1"/);
  assert.match(routes,/if\(workPanel\)res.setHeader\("Cache-Control","private, no-store"\)/);
});

test("available then monthly first-unit sorting precedes page; denied or stale monthly cache contributes nothing",()=>{
  const sql=src("apps/api/src/services/item-composition-peers.ts");
  assert.match(sql,/workPanel&&hasEnabledView\("company.sales"\)&&hasEnabledView\("company.invoice"\)/);
  assert.match(sql,/canViewStock\?\[workPanel\?`\$\{availableStock\}\/\$\{firstUnit\} DESC\`/);
  assert.match(sql,/monthlyReady\?\[`\$\{monthlySales\} DESC\`\]/);
  assert.match(sql,/ORDER BY \$\{order\} LIMIT \$5 OFFSET \$4/);
  assert.match(sql,/COALESCE\(sale_rank.net_sale_quantity,0\)[\s\S]+COALESCE\(staged_rank.net_sale_quantity,0\)\+COALESCE\(planning_fix.month_delta,0\)/);
  assert.match(sql,/monthlyReady\?`round\(\$\{monthlySales\},4\)::text\`:"NULL::text"/);
  assert.match(sql,/error.code!=="search_updating"/);
});
