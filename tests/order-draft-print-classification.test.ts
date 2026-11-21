import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Database } from "../apps/api/src/db.ts";
import { readDraftPrintClassifications } from "../apps/api/src/services/draft-print-classifications.ts";
import { orderDraftPrintSections, type DraftPrintClassification } from "../apps/web/src/order-draft-print-sections.ts";
import { balanceItemNamesColumns,createSectionedTwoColumnItemNamesPdf } from "../apps/web/src/item-names-pdf.ts";

test("print groups medicine and verified blank first, then medical, combined, health with separators",()=>{
  const rows=Array.from({length:9},(_,i)=>({itemId:i+1,name:`Name ${i+1}`,requiredQuantity:"24"}));
  const classes=new Map<number,DraftPrintClassification>([
    [1,"health_supplies"],[2,null],[3,"medical_supplies"],[4,"medicine"],
    [5,"medical_and_health_supplies"],[6,"medical_supplies"],[7,"health_supplies"],
    [8,"medical_and_health_supplies"],[9,null],
  ]);
  const result=orderDraftPrintSections(rows,classes)!;
  assert.deepEqual(result.map(section=>section.map(row=>row.itemId)),[[2,4,9],[3,6,5,8,1,7]]);
  assert.deepEqual(result[1]!.map(row=>row.separatorBefore),[false,false,true,false,true,false]);
  assert.ok(result.flat().every(row=>row.requiredQuantity==="24"));
  assert.deepEqual(orderDraftPrintSections(rows.filter(row=>row.itemId===1||row.itemId===3),classes)?.map(section=>
    section.map(row=>[row.itemId,row.separatorBefore])),[[[3,false],[1,true]]]);
  assert.equal(orderDraftPrintSections([{itemId:10}],classes),null);
  assert.equal(orderDraftPrintSections([{itemId:2}],classes)?.length,1);
  assert.deepEqual(orderDraftPrintSections([],classes),[]);
});

test("print classification SQL does not read other tenants or require inventory reports",async()=>{
  const db=await PGlite.create();
  try{
    await db.exec(`CREATE TABLE items(company_id int,id int,composition_id int);
      CREATE TABLE item_compositions(company_id int,id int,classification text);
      INSERT INTO items VALUES (1,10,1),(1,11,NULL),(1,12,2),(2,13,1);
      INSERT INTO item_compositions VALUES (1,1,'medical_supplies'),(2,2,'health_supplies'),(2,1,'medicine');`);
    const result=await readDraftPrintClassifications(db as unknown as Database,1,[10,11,12,13]);
    assert.deepEqual(result.sort((a,b)=>a.itemId-b.itemId),[
      {itemId:10,compositionClassification:"medical_supplies"},
      {itemId:11,compositionClassification:null},
      {itemId:12,compositionClassification:null},
    ]);
    const route=await readFile(new URL("../apps/api/src/routes-item-options-list.ts",import.meta.url),"utf8");
    const snippet=route.split('router.post("/companies/:companyId/item-options-list/draft-print-classifications"')[1]?.split("  /**")[0];
    assert.ok(snippet);
    assert.match(snippet,/checkPresetsAccess\(client,req,companyId\)/);
    assert.doesNotMatch(snippet,/canReadItemCoverage|company\.sales|company\.stock/);
  }finally{await db.close();}
});

test("PDF starts each nonempty section on another sheet, keeps quantities, and drops a leading separator",async()=>{
  const previous=globalThis.document;
  const sheetTexts:{text:string;y:number}[][]=[];
  let drawn:{text:string;y:number}[]=[];
  const ctx={
    setTransform(){},fillRect(){drawn=[];},beginPath(){},setLineDash(){},moveTo(){},lineTo(){},stroke(){},save(){},restore(){},
    measureText(text:string){return {width:text.length*5};},
    fillText(text:string,_x:number,y:number){drawn.push({text,y});},
  };
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>({
    getContext:()=>ctx,toDataURL:()=>{sheetTexts.push(drawn);return "data:image/jpeg;base64,/9j/2Q==";},
  })}});
  try{
    const pdf=createSectionedTwoColumnItemNamesPdf([[],[
      {name:"Medicine",requiredQuantity:"3"},
    ],[
      {name:"Medical supply",requiredQuantity:"8",separatorBefore:true},
    ],[]]);
    assert.equal(pdf.type,"application/pdf");
    assert.match(await pdf.text(),/\/Type \/Pages \/Count 2/);
    assert.deepEqual(sheetTexts.map(rows=>rows.map(row=>row.text)),[["3","Medicine"],["8","Medical supply"]]);
    assert.equal(sheetTexts[0]?.[0]?.y,sheetTexts[1]?.[0]?.y,"gaps never precede the first real row of a new sheet");
    assert.deepEqual(balanceItemNamesColumns([6,6,6,6],10,[0,3,3,3]),
      [{start:0,split:1,end:2},{start:2,split:3,end:4}]);
  }finally{Object.defineProperty(globalThis,"document",{configurable:true,value:previous});}
});
