import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { signedStockMovementQuantity } from "../apps/web/src/stock-movement-display.ts";
import { pageDefinitions } from "../packages/contracts/src/pages.ts";
const read=(p:string)=>readFileSync(p,"utf8");

test("signed stock movements preserve exact quantities",()=>{
  assert.equal(signedStockMovementQuantity("1"),"+1");
  assert.equal(signedStockMovementQuantity("1250000"),"+1250000");
  assert.equal(signedStockMovementQuantity("-999999999999999999"),"-999999999999999999");
  assert.equal(signedStockMovementQuantity("0"),"0");
});
test("the avatar and invoice item sidebar contain the same unified ledger",()=>{
  const avatar=read("apps/web/src/ItemMenuHistory.tsx");
  const invoice=read("apps/web/src/pages/CommercePages.tsx");
  assert.match(avatar,/key: "movement", label: "حركة الصنف"/);
  assert.match(avatar,/stock-movements\?\$\{new URLSearchParams/);
  assert.match(avatar,/signedStockMovementQuantity\(row\.quantitySmallest\)/);
  assert.match(invoice,/value: "movement", label: "حركة الصنف"/);
  assert.match(invoice,/view === "movement"/);
  assert.match(invoice,/stock-movements\?\$\{new URLSearchParams/);
  assert.match(invoice,/signedStockMovementQuantity\(row\.quantitySmallest\)/);
});
test("the existing protected inventory ledger is the date-range all-items page",()=>{
  const page=pageDefinitions.find(entry=>entry.key==="company.stock-movements");
  assert.ok(page);
  assert.equal(page.name,"حركة الأصناف");
  assert.equal(page.route,"/companies/:companyId/stock-movements");
  assert.deepEqual(page.actions.view?.permissions,["inventory.view"]);
  const ui=read("apps/web/src/pages/InventoryPages.tsx");
  const server=read("apps/api/src/routes-inventory.ts");
  assert.match(ui,/title="حركة الأصناف"/);
  assert.match(ui,/label="من تاريخ"/);
  assert.match(ui,/label="إلى تاريخ"/);
  assert.match(ui,/signedStockMovementQuantity\(row\.original\.quantitySmallest\)/);
  assert.match(server,/for \(const key of \["dateFrom", "dateTo"\] as const\)/);
  assert.match(server,/AND m\.document_date/);
  assert.match(ui,/dateFrom", "dateTo"/);
});
