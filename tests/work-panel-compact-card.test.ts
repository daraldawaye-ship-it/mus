import assert from "node:assert/strict";
import { test } from "node:test";
import { compactItemDraft, compactItemFieldPatch, compactItemSingleFieldPatch, createCompactItemAutosave, stepCompactItemValue } from "../apps/web/src/work-panel-compact-card.ts";

const item={reserveQuantity:"12",purchaseFactor:6,minOrderQuantity:"1",orderAlertQuantity:null,reviewed:false};
test("compact card only patches deliberately changed canonical fields with field-level compare-and-set",()=>{
  const draft=compactItemDraft(item);
  assert.deepEqual(compactItemFieldPatch(item,draft),{payload:null});
  assert.deepEqual(compactItemFieldPatch(item,{...draft,orderAlertQuantity:"٠",reviewed:true}),{
    payload:{changes:{orderAlertQuantity:"0",reviewed:true},expected:{orderAlertQuantity:null,reviewed:false}},
  });
  const enabled={...item,orderAlertQuantity:"0"};
  assert.deepEqual(compactItemFieldPatch(enabled,{...compactItemDraft(enabled),orderAlertQuantity:""}),{
    payload:{changes:{orderAlertQuantity:null},expected:{orderAlertQuantity:"0"}},
  });
  assert.deepEqual(compactItemFieldPatch(item,{...draft,reserveQuantity:"١٢",purchaseFactor:"06"}),{payload:null});
  assert.match(compactItemFieldPatch(item,{...draft,reserveQuantity:"-1"}).error??"",/كمية احتياط/);
  assert.match(compactItemFieldPatch(item,{...draft,minOrderQuantity:"0"}).error??"",/أقل كمية طلب/);
  assert.match(compactItemFieldPatch(item,{...draft,purchaseFactor:"0"}).error??"",/عامل وحدة الشراء/);
});

test("compact card steppers preserve integers, nullable blank, safe bounds, and high precision",()=>{
  assert.equal(stepCompactItemValue("orderAlertQuantity","",1),"0");
  assert.equal(stepCompactItemValue("orderAlertQuantity","",-1),"");
  assert.equal(stepCompactItemValue("orderAlertQuantity","0",-1),"0");
  assert.equal(stepCompactItemValue("reserveQuantity","٩٠٠٧١٩٩٢٥٤٧٤٠٩٩٣",1),"9007199254740994");
  assert.equal(stepCompactItemValue("minOrderQuantity","1",-1),"1");
  assert.equal(stepCompactItemValue("minOrderQuantity","2147483647",1),"2147483647");
  assert.equal(stepCompactItemValue("purchaseFactor","1000000",1),"1000000");
});

test("single-field autosave uses canonical CAS and preserves required/nullable rules",()=>{
  assert.deepEqual(compactItemSingleFieldPatch(item,"purchaseFactor","7"),{
    payload:{changes:{purchaseFactor:7},expected:{purchaseFactor:6}},
  });
  assert.match(compactItemSingleFieldPatch(item,"minOrderQuantity","").error??"",/أقل كمية طلب/);
  assert.deepEqual(compactItemSingleFieldPatch({...item,orderAlertQuantity:"0"},"orderAlertQuantity",""),{
    payload:{changes:{orderAlertQuantity:null},expected:{orderAlertQuantity:"0"}},
  });
  assert.deepEqual(compactItemSingleFieldPatch(item,"reviewed",true),{
    payload:{changes:{reviewed:true},expected:{reviewed:false}},
  });
});

test("rapid commits coalesce per field without delaying other fields or switching scope",async()=>{
  const calls:[string,unknown][]=[];
  let release!:()=>void;
  const first=new Promise<void>(resolve=>{release=resolve;});
  let scoped=true;
  const queue=createCompactItemAutosave(()=>scoped,async(key,value)=>{
    calls.push([key,value]);
    if(key==="purchaseFactor"&&value==="7") await first;
  },()=>{});
  const purchase=queue.enqueue("purchaseFactor","7");
  await queue.enqueue("purchaseFactor","8");
  await queue.enqueue("purchaseFactor","9");
  await queue.enqueue("reviewed",true);
  assert.deepEqual(calls,[["purchaseFactor","7"],["reviewed",true]]);
  release();
  await purchase;
  assert.deepEqual(calls,[["purchaseFactor","7"],["reviewed",true],["purchaseFactor","9"]]);

  let finish!:()=>void;
  const inFlight=new Promise<void>(resolve=>{finish=resolve;});
  const moving=createCompactItemAutosave(()=>scoped,async(key,value)=>{
    calls.push([key,value]);
    await inFlight;
  },()=>{});
  const old=moving.enqueue("reserveQuantity","14");
  await moving.enqueue("reserveQuantity","15");
  scoped=false;
  finish();
  await old;
  assert.deepEqual(calls.at(-1),["reserveQuantity","14"]);
});

test("a failed field cannot dispatch a queued overwrite or prevent another field",async()=>{
  const calls:string[]=[];
  let fail!:()=>void;
  const delayed=new Promise<void>((_,reject)=>{fail=()=>reject(new Error("conflict"));});
  const queue=createCompactItemAutosave(()=>true,async(key,value)=>{
    calls.push(`${key}:${value}`);
    if(key==="purchaseFactor")await delayed;
  },()=>{});
  const result=queue.enqueue("purchaseFactor","7");
  const rejected=assert.rejects(result,/conflict/);
  await queue.enqueue("purchaseFactor","8");
  await queue.enqueue("reviewed",true);
  fail();
  await rejected;
  assert.deepEqual(calls,["purchaseFactor:7","reviewed:true"]);
});
