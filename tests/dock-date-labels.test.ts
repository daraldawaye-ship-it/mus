import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
const file=(name:string)=>readFile(new URL("../apps/web/src/"+name,import.meta.url),"utf8");

test("both dock date ranges use only من and إلى visibly with accessible names, not the ordinary preview",async()=>{
 const item=await file("ItemMenuHistory.tsx"), account=await file("pages/AccountsPage.tsx");
 assert.match(item,/isMovement && workPanelMovement && \([\s\S]*?<label>من\s*<input type="date" aria-label="بداية فترة حركة الصنف"/);
 assert.match(item,/<label>إلى\s*<input type="date" aria-label="نهاية فترة حركة الصنف"/);
 assert.match(account,/hideFullLink \? <div className="work-panel-date-range"[\s\S]*<label>من <input type="date" aria-label="بداية فترة كشف الحساب"[\s\S]*<label>إلى <input type="date" aria-label="نهاية فترة كشف الحساب"/);
 assert.match(account,/: <div className="accounts-ledger-dates">[\s\S]*label="من تاريخ"[\s\S]*label="إلى تاريخ"/);
});
test("narrow dock date controls always share two shrinkable columns with no flex wrapping",async()=>{
 const css=await file("WorkPanelLayout.css");
 assert.match(css,/\.work-panel-date-range \{[^}]*display: grid;[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
 assert.match(css,/\.work-panel-date-range label \{[^}]*min-inline-size: 0/);
 assert.match(css,/\.work-panel-date-range input \{[^}]*flex: 1 1 0;[^}]*inline-size: 0;[^}]*min-inline-size: 0/);
});

test("both dock ranges start empty and ledger omits each blank boundary without fetching extra rows",async()=>{
 const item=await file("ItemMenuHistory.tsx"), account=await file("pages/AccountsPage.tsx");
 for(const direction of ["From","To"]){
   assert.ok(item.includes(`const [movement${direction}, setMovement${direction}] = useState("");`));
   assert.ok(account.includes(`const [date${direction}, setDate${direction}] = useState(()=>hideFullLink?"":todayInAdenForAccountPreview());`));
   assert.ok(account.includes(`...((!hideFullLink||date${direction})?{date${direction}}:{}),`));
 }
 assert.match(account,/accountId: String\(account.id\),[\s\S]*?pageSize: "20",\s*sort: "documentDate:desc,documentId:desc,lineNumber:desc"/);
});
