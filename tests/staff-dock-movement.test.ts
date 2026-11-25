import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {PGlite} from "@electric-sql/pglite";
import {mayReadStaffDockMovement,staffDockMovementSql,staffDockItemsSql} from "../apps/api/src/services/staff-dock-movement.ts";

test("item dock role grants only the two active positions or owner, not base inventory perms, stale or other staff",()=>{
 const user={owner:false,suspended:false,archived:false};
 assert.equal(mayReadStaffDockMovement(user,{active:true,positions:["sales"]}),true);
 assert.equal(mayReadStaffDockMovement(user,{active:true,positions:["cashier"]}),true);
 assert.equal(mayReadStaffDockMovement(user,{active:true,positions:["accountant"]}),false);
 assert.equal(mayReadStaffDockMovement(user,{active:false,positions:["sales"]}),false);
 assert.equal(mayReadStaffDockMovement({...user,suspended:true},{active:true,positions:["sales"]}),false);
 assert.equal(mayReadStaffDockMovement({...user,archived:true},{active:true,positions:["cashier"]}),false);
 assert.equal(mayReadStaffDockMovement(user,null),false);
 assert.equal(mayReadStaffDockMovement({...user,owner:true},null),true);
});
test("read projections are exact to tenant/item, posted invoice kinds and minimal named fields",async()=>{
 const db=await PGlite.create();
 try{
  await db.exec(`
   CREATE TABLE items(id int,company_id int,name text,code text,active boolean);
   INSERT INTO items VALUES (8,2,'Product','BB',true),(8,3,'Private','BB',true),(9,2,'Inactive','BB',false),(10,2,'Active','XX',true);
   CREATE TABLE stock_movements(id int,company_id int,item_id int,kind text,document_date date,quantity_smallest int,invoice_id int,invoice_line_id int,notes text,operation_id int);
   CREATE TABLE stock_operations(id int,company_id int,kind text);
   INSERT INTO stock_operations VALUES (3416,2,'adjustment'),(3417,2,'adjustment'),(3420,3,'adjustment'),(3421,2,'transfer');
   CREATE TABLE invoices(id int,company_id int,kind text,posted boolean,party text,total int,decimal_places int);
   CREATE TABLE invoice_lines(id int,company_id int,invoice_id int,item_id int,unit_price numeric,factor2 int,factor3 int,unit int,gross numeric,discount numeric);
   INSERT INTO invoices VALUES (1,2,'sale',true,'hidden',900,0),(2,2,'purchase',true,'hidden',999,0),(3,2,'sale',false,'hidden',0,0),(1,3,'sale',true,'outside',99,0);
   INSERT INTO invoice_lines VALUES (101,2,1,8,12,2,10,2,12,2),(102,2,2,8,15,3,10,1,-15,-3),(103,2,3,8,12,2,10,1,12,0),(104,2,1,9,12,2,10,1,12,0),(101,3,1,8,10,1,1,1,10,0);
   INSERT INTO stock_movements VALUES
   (1,2,8,'sale','2026-11-20',-10,1,101,'hidden',null),(2,2,8,'purchase_return','2026-11-21',-30,2,102,'hidden',null),
   (3,2,8,'sale','2026-11-22',-10,3,103,'unposted',null),(4,3,8,'sale','2026-11-21',-10,1,101,'outside',null),
   (5,2,8,'transfer_in','2026-11-22',10,null,null,'unlinked',null),(6,2,10,'sale','2026-11-22',-7,1,101,'wrong item',null),(7,2,9,'sale','2026-11-22',-7,1,104,'inactive',null),
   (356188,2,8,'adjustment_surplus','2026-11-22',13,null,null,'private memo',3416),
   (356189,2,8,'adjustment_shortage','2026-11-23',-2,null,null,'private memo',3417),
   (356190,2,8,'adjustment_shortage','2026-11-23',-8,null,null,'other tenant',3420),
   (356191,2,8,'adjustment_surplus','2026-11-23',14,null,null,'not real adjustment',3421),
   (356192,2,9,'adjustment_surplus','2026-11-23',1,null,null,'inactive',3416);
  `);
  assert.deepEqual((await db.query(staffDockItemsSql,[2,"%BB%",0])).rows,[{id:8,name:"Product",code:"BB"}]);
  const rows=(await db.query(staffDockMovementSql,[2,8,null,null,false,0])).rows;
  assert.deepEqual(rows,[
   {id:356189,kind:"adjustment_shortage",documentDate:"2026-11-23",quantitySmallest:"-2",postedUnitPrice:null,firstUnitMultiplier:null,unitPriceFirstUnit:null,lineValue:null,lineDiscount:null,lineNet:null,operationId:3417},
   {id:356188,kind:"adjustment_surplus",documentDate:"2026-11-22",quantitySmallest:"13",postedUnitPrice:null,firstUnitMultiplier:null,unitPriceFirstUnit:null,lineValue:null,lineDiscount:null,lineNet:null,operationId:3416},
   {id:2,kind:"purchase_return",documentDate:"2026-11-21",quantitySmallest:"-30",postedUnitPrice:"15",firstUnitMultiplier:"30",unitPriceFirstUnit:"15",lineValue:"-15",lineDiscount:"-3",lineNet:"-12",operationId:null},
   {id:1,kind:"sale",documentDate:"2026-11-20",quantitySmallest:"-10",postedUnitPrice:"12",firstUnitMultiplier:"20",unitPriceFirstUnit:"24",lineValue:"12",lineDiscount:"2",lineNet:"10",operationId:null}
  ]);
  assert.deepEqual((await db.query(staffDockMovementSql,[2,8,"2026-11-21",null,true,0])).rows,[rows[2]]);
  assert.deepEqual((await db.query(staffDockMovementSql,[2,8,"2026-11-22","2026-11-22",false,0])).rows,[rows[1]]);
  assert.deepEqual((await db.query(staffDockMovementSql,[2,8,null,null,false,2])).rows,rows.slice(2));
  assert.deepEqual((await db.query(staffDockMovementSql,[2,9,null,null,false,0])).rows,[]);
 }finally{await db.close()}
});
test("mounted fallback keeps rank search and direct historic data paths separate and private",async()=>{
 const file=(name:string)=>readFile(new URL("../apps/"+name,import.meta.url),"utf8");
 const server=await file("api/src/routes-commerce.ts"),tool=await file("web/src/WorkPanelTools.tsx");
 const scope=server.split("async function readStaffDock")[1]?.split("`\${base}/item-history/:itemId/movement-invoices`")[0]??"";
 assert.match(scope,/await companyAccess\(client,user,companyId\)/);
 assert.match(scope,/X-Alraesy-Employee-Preview/);
 assert.match(scope,/mayReadStaffDockMovement\(user,context\.employee\)/);
 assert.equal((scope.match(/private, no-store/g)??[]).length,2);
 assert.match(tool,/staffDockLookup=\{staffItemDock\?\(reads.item\?"fallback":"limited"\):undefined\}/);
 assert.match(tool,/staffDockMovement=\{staffItemDock&&/);
 const lookup=await file("web/src/EntityMenuSearch.tsx");
 assert.match(lookup,/const minimumSearch=limitedItem\?2:1/);
 assert.match(lookup,/error instanceof ApiFailure&&error.status===403\) return limited\(\)/);
 assert.match(lookup,/work-panel-items\?\$\{new URLSearchParams/);
 assert.match(lookup,/embeddedItem&&result.isError\?\[\]/);
 const view=await file("web/src/ItemMenuHistory.tsx");
 assert.match(view,/enabled: !staffDockMovement &&/);
 assert.match(view,/!staffDockMovement && workPanelMovement/);
 const exact=server.split("/item-history/:itemId/movement-invoices")[1]?.split("/invoice-stock-preview")[0]??"";
 assert.match(exact,/await readStaffDock\(req,/);
 assert.doesNotMatch(exact,/inventory\.view|directoryEntries|invoiceNet|partyName/);
 assert.equal((view.match(/<MovementLineHead \/>/g)??[]).length,2);
 assert.match(view,/>القيمة<[^]*>الخصم<[^]*>الصافي</);
 assert.match(view,/!staffDockMovement && !purchaseOnly && itemId/);
});
