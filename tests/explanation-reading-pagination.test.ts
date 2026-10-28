import assert from "node:assert/strict";
import test from "node:test";
import {estimateReadingLines,takeReadingSlice} from "../apps/api/src/explanation-reading-pagination.ts";
const make=(length:number,kind="heading")=>({
  row:{kind,title:"الفصل",body_chars:length,body_breaks:0,evidence_chars:0,evidence_breaks:0},
});
test("a guide with forty long chapters must not return all chapters in the first page",()=>{
  const records=Array.from({length:40},()=>make(420));
  const first=takeReadingSlice(records,0);
  assert.ok(first.length<40);
  assert.ok(first.length>0);
  let offset=0,visited=0;
  while(offset<records.length){
    const slice=takeReadingSlice(records,offset);
    assert.ok(slice.length>0);
    offset+=slice.length;
    visited+=slice.length;
  }
  assert.equal(visited,40);
});
test("explicit newline and long evidence both contribute to the line limit",()=>{
  const base=make(70).row;
  assert.ok(estimateReadingLines({...base,body_breaks:10})>estimateReadingLines(base));
  assert.ok(estimateReadingLines({...base,evidence_chars:500})>estimateReadingLines(base));
});
test("very long single node cannot produce an empty page or stall scrolling",()=>{
  const records=[make(20000),make(50)];
  const first=takeReadingSlice(records,0);
  assert.equal(first.length,1);
  const second=takeReadingSlice(records,first.length);
  assert.equal(second.length,1);
});
test("still caps small nodes at fifty records and supports an empty tail",()=>{
  const records=Array.from({length:100},()=>make(0,"paragraph"));
  assert.equal(takeReadingSlice(records,0).length,50);
  assert.equal(takeReadingSlice(records,100).length,0);
});
