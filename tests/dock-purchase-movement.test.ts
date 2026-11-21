import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {PGlite} from "@electric-sql/pglite";
const file=(name:string)=>readFile(new URL("../apps/"+name,import.meta.url),"utf8");
test("purchase movement SQL independently includes both purchase kinds before count and paging",async()=>{
 const route=await file("api/src/routes-inventory.ts");
 const snippet=route.split('`${base}/stock-movements`')[1]!.split("router.post")[0]!;
 assert.match(snippet,/typeof req\.query\.itemId !== "string" \|\| req\.query\.kind !== undefined/);
 assert.match(snippet,/\["company.stock-movements","company.purchases"\][\s\S]*assertDirectoryAccess\(entry,"view"\)/);
 const predicate=snippet.match(/if \(purchaseOnly\) where \+= "([^"]+)"/)?.[1];
 assert.ok(predicate);
 assert.ok(snippet.indexOf(predicate)<snippet.indexOf("SELECT count("));
 const db=await PGlite.create();
 try{
   await db.exec("CREATE TABLE movement(id int,company_id int,item_id int,kind text); INSERT INTO movement VALUES (1,2,8,'sale'),(2,2,8,'purchase'),(3,2,8,'purchase_return'),(4,3,8,'purchase'),(5,2,9,'purchase'),(6,2,8,'transfer_in');");
   const scoped="FROM movement m WHERE company_id=$1 AND item_id=$2"+predicate;
   assert.deepEqual((await db.query("SELECT count(*)::int AS total "+scoped,[2,8])).rows,[{total:2}]);
   assert.deepEqual((await db.query("SELECT id "+scoped+" ORDER BY id LIMIT 1 OFFSET 1",[2,8])).rows,[{id:3}]);
 }finally{await db.close()}
});
test("purchase is independent and immediately after movement; both mounts reuse compact UI without sharing filtered cache",async()=>{
 const panel=await file("web/src/WorkPanelTools.tsx"),view=await file("web/src/ItemMenuHistory.tsx");
 assert.match(panel,/key: "movement", label: "الحركة" \},\s*\{ key: "purchases", label: "المشتريات" \},\s*\{ key: "card"/);
 assert.match(panel,/\["company.stock-movements","company.purchases"\][\s\S]*entry\.enabled&&entry\.actionAccess\.view/);
 assert.match(panel,/purchaseOnly=\{view\.key === "purchases"\}/);
 assert.match(view,/queryKey: \["avatar-item-stock-movements",[^\n]*purchaseOnly\]/);
 assert.match(view,/purchaseOnly \? \{ purchaseOnly: "1" \} : \{\}/);
});
