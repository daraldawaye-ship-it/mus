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
    assert.match(snippet,/checkPresetsAccess\(client,req,companyId,false,false\)/);
    assert.doesNotMatch(snippet,/canReadItemCoverage|company\.sales|company\.stock/);
  }finally{await db.close();}
});

test("PDF draws both solid dividers and a full-line gap, including at the start of its left column",async()=>{
  const previous=globalThis.document;
  const sheets:{texts:{text:string;x:number;y:number}[];dividers:{x:number;y:number}[]}[]=[];
  const fresh=()=>({texts:[] as {text:string;x:number;y:number}[],dividers:[] as {x:number;y:number}[]});
  let drawn=fresh(), origin={x:0,y:0}, dash:number[]=[];
  const ctx={
    strokeStyle:"",setTransform(){},fillRect(){drawn=fresh();},beginPath(){},
    setLineDash(next:number[]){dash=next;},moveTo(x:number,y:number){origin={x,y};},lineTo(){},
    stroke(){if(ctx.strokeStyle==="#999"&&dash.length===0)drawn.dividers.push(origin);},save(){},restore(){},
    measureText(text:string){return {width:text.length*5};},
    fillText(text:string,x:number,y:number){drawn.texts.push({text,x,y});},
  };
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>({
    getContext:()=>ctx,toDataURL:()=>{sheets.push(drawn);return "data:image/jpeg;base64,/9j/2Q==";},
  })}});
  try{
    const rows=[
      {name:"Health supply",requiredQuantity:"7",itemId:1},
      {name:"Medical supply A",requiredQuantity:"8",itemId:2},
      {name:"Combined supply",requiredQuantity:"9",itemId:3},
      {name:"Medicine",requiredQuantity:"3",itemId:4},
      {name:"Medical supply B",requiredQuantity:"5",itemId:5},
    ];
    const classes=new Map<number,DraftPrintClassification>([[1,"health_supplies"],[2,"medical_supplies"],[3,"medical_and_health_supplies"],[4,"medicine"],[5,"medical_supplies"]]);
    const pdf=createSectionedTwoColumnItemNamesPdf(orderDraftPrintSections(rows,classes)!);
    assert.equal(pdf.type,"application/pdf");
    assert.match(await pdf.text(),/\/Type \/Pages \/Count 2/);
    assert.deepEqual(sheets.map(sheet=>sheet.texts.map(row=>row.text)),[
      ["3","Medicine"],["8","Medical supply A","5","Medical supply B","9","Combined supply","7","Health supply"],
    ]);
    const [medicine,supplies]=sheets;
    assert.equal(medicine?.dividers.length,0);
    assert.equal(supplies?.dividers.length,2);
    const [first,second]=supplies!.dividers;
    const byLabel=(label:string)=>supplies!.texts.find(entry=>entry.text===label)!;
    const medical=byLabel("Medical supply A"), combined=byLabel("Combined supply"), health=byLabel("Health supply");
    assert.ok(combined.x < medical.x,"combined is first in the left column");
    assert.equal(combined.x,health.x);
    assert.equal(first!.x,second!.x);
    assert.ok(Math.abs(combined.y-medical.y-12.90)<0.01,"the left-column divider consumes a full extra line and stroke");
    for(const [label,line] of [[combined,first],[health,second]] as const){
      assert.ok(label.y-line!.y>12.15,"each solid stroke is followed by a full line of whitespace");
    }
    assert.deepEqual(balanceItemNamesColumns([6,6,6,6],10,[0,3,3,3]),
      [{start:0,split:1,end:2},{start:2,split:3,end:4}]);
    assert.deepEqual(balanceItemNamesColumns([6,6,6,6],12,[0,0,3,0]),
      [{start:0,split:2,end:3},{start:3,split:4,end:4}],"the leading gap uses capacity at the column start");
  }finally{Object.defineProperty(globalThis,"document",{configurable:true,value:previous});}
});

test("native print attaches the separator as a solid border and padded complete line",async()=>{
  const css=await readFile(new URL("../apps/web/src/styles.css",import.meta.url),"utf8");
  const rule=css.match(/\.item-order-draft-print-section \.item-order-draft-print-separator \{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule,/border-block-start: 1px solid #999/);
  assert.match(rule,/padding-block-start: calc\(1\.2mm \+ 1\.35em\)/);
  assert.doesNotMatch(rule,/margin-break|break-before/);
});
