import assert from "node:assert/strict";
import test from "node:test";
import {isHistoricalAiTaskReceipt,pageAiTaskHistory} from "../apps/api/src/services/ai-task-history-page.ts";
const date=(day)=>`2026-11-${String(day).padStart(2,"0")}T03:00:00.000Z`;
const runs=Array.from({length:23},(_,i)=>({id:i+1,startedAt:date(i+1),finishedAt:date(i+1),durationSeconds:4,recordedAt:date(26-i),historicalReceipt:false}));
test("max ten chronological verified records; old/ambiguous imports don't displace newest",()=>{
 const old={id:90,startedAt:null,finishedAt:date(28),durationSeconds:null,recordedAt:date(28),historicalReceipt:false};
 const archive={...old,id:91,startedAt:date(29),finishedAt:date(29),durationSeconds:4,historicalReceipt:isHistoricalAiTaskReceipt("أرشيف سجل","دفعة قديمة")};
 const recent=pageAiTaskHistory([old,archive,...runs],"recent",1,null);
 assert.deepEqual(recent.history.map(x=>x.id),[23,22,21,20,19,18,17,16,15,14]);
 assert.equal(recent.olderCount,15);
 const older1=pageAiTaskHistory([old,archive,...runs],"older",1,null);
 const older2=pageAiTaskHistory([old,archive,...runs],"older",2,null);
 assert.equal(older1.history.length,10);
 assert.equal(older1.hasMore,true);
 assert.equal(older2.history.length,5);
 assert.equal(older2.hasMore,false);
 assert.equal(new Set([recent,older1,older2].flatMap(x=>x.history.map(x=>x.id))).size,25);
 assert.equal(older1.history.find(x=>x.id===91).historical,true);
});
test("exact active start takes a slot; an obsolete start stays in older history",()=>{
 const active={id:98,startedAt:date(26),finishedAt:null,durationSeconds:null,recordedAt:date(26),historicalReceipt:false};
 const old={...active,id:97,startedAt:date(24)};
 const result=pageAiTaskHistory([old,active,...runs],"recent",1,date(26));
 assert.equal(result.history[0].id,98);
 assert.equal(result.history.length,10);
 assert.equal(result.history.some(x=>x.id===97),false);
 assert.equal(result.olderCount,15);
});
