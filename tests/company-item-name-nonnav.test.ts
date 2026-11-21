import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
const page=(name:string)=>readFile(new URL("../apps/web/src/pages/"+name+".tsx",import.meta.url),"utf8");
test("draft item labels are nonnavigating on D13 and mobile, retaining quantity, selection and typed row sync",async()=>{
 const source=await page("ItemOrderDraftsPage");
 assert.equal((source.match(/<span className="company-item-label">/g)??[]).length,2);
 assert.doesNotMatch(source,/items\/" \+ row\.item\.id\}>\{row\.item\.name\}/);
 assert.match(source,/dockRowSource=\{row=>\(\{companyId,itemId:row\.item\.id,itemName:row\.item\.name\}\)\}/);
 assert.match(source,/selectItem\(row\.item\.id, event\.target\.checked\)/);
 assert.match(source,/drafts\.updateItemQuantity\(row\.draftId, row\.item\.id, quantity\)/);
});
test("company item name links and name-button cards are removed, explicit card actions and market cards are retained",async()=>{
 const pages=["ItemOrderLevelsPage","StoppedOrderItemsPage","SettlementFollowUpPage","AutomaticTasksPage","ItemOptionsListPage","ItemStatisticsReportPage","ExpiryAlertFollowUpPage"];
 for(const name of pages){
   const source=await page(name);
   assert.doesNotMatch(source,/<Link\b[^>]*to=\{[^>]*\/items\//,name);
 }
 const items=await page("ItemsPages");
 assert.equal((items.match(/onClick=\{\(\) => setSheetItemId\(row\.original\.id\)\}/g)??[]).length,1);
 assert.match(items,/dockRowEntity="item"/);
 assert.doesNotMatch(items,/openItemCardSheet\(companyId, peer\.id\)/);
 const comp=await page("ItemCompositionsPage");
 assert.doesNotMatch(comp,/onOpenItem\(group\.topSellingItem/);
 assert.match(comp,/onClick=\{\(\)=>onOpenItem\(item\.id\)\}>كرت الصنف/);
 const exports=await page("OrderDraftExportsPage");
 assert.match(exports,/purchase-comparison-item-card-link.+\/items\//);
 assert.match(exports,/onClick=\{\(\) => setSidePanel/);
 const market=await page("InterestStatisticsPage");
 assert.match(market,/medicine-market\?card=/);
 assert.doesNotMatch(market,/company-item:\)\?/);
 assert.doesNotMatch(market,/card\.target_type\.startsWith\("company-item:"\)/);
});
