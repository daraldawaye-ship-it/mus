import assert from "node:assert/strict";
import test from "node:test";
import {PGlite} from "@electric-sql/pglite";
import {documentWorkStatuses} from "../packages/contracts/src/legal-document-review.ts";
import {automationWorkStateSql,manualWorkStateSql,preserveDocumentWorkStatuses} from "../apps/api/src/services/legal-document-work-status.ts";

test("explicit independent statuses, positive real manual need, no assumed completion",async()=>{
 const db=new PGlite();
 try{
  await db.exec("CREATE TABLE legal_records(id int,kind text,transcription_status text,document_review jsonb,visible boolean)");
  const cases=[
   [1,"document","complete",{evidenceSummary:"file read"},true],
   [2,"document","partial",{manualTranscription:true,importanceScore:8,missingPassage:"signed line"},true],
   [3,"document","partial",{manualTranscription:true,missingPassage:"uncertain line"},true],
   [4,"document","complete",{automationWorkStatus:"remaining",manualWorkStatus:"none"},true],
   [5,"document","partial",{automationWorkStatus:"completed",manualWorkStatus:"remaining"},true],
   [6,"document","partial",{automationWorkStatus:"completed",manualWorkStatus:"none"},true],
   [7,"fact","partial",{automationWorkStatus:"completed",manualWorkStatus:"none"},true],
   [8,"document","partial",{automationWorkStatus:"completed",manualWorkStatus:"none"},false],
   [9,"document","complete",{manualTranscription:true,importanceScore:8,missingPassage:"old"},true],
   [10,"document","partial",{},true],
  ];
  for(const p of cases)await db.query("INSERT INTO legal_records VALUES($1,$2,$3,$4,$5)",[...p.slice(0,3),JSON.stringify(p[3]),p[4]]);
  const sql=await db.query("SELECT id,"+automationWorkStateSql+" AS automation,"+manualWorkStateSql+" AS manual FROM legal_records r ORDER BY id");
  assert.deepEqual(sql.rows,cases.map(([id,_kind,state,review])=>({id,...documentWorkStatuses(review,state)})));
  const body=" FROM legal_records r WHERE r.visible AND r.kind='document' AND ("+automationWorkStateSql+")=$1 AND ("+manualWorkStateSql+")=$2";
  const both=await db.query("SELECT id"+body+" ORDER BY id DESC LIMIT 100",["completed","none"]);
  const count=await db.query("SELECT count(*)::integer AS n"+body,["completed","none"]);
  assert.deepEqual(both.rows,[{id:6}]);
  assert.equal(count.rows[0].n,1);
  assert.deepEqual(documentWorkStatuses(undefined,"complete"),{automation:"unknown",manual:"unknown"});
 }finally{await db.close();}
});
test("legacy full review writes preserve statuses; explicit unknown is a real reset",()=>{
 const prior={automationWorkStatus:"completed",manualWorkStatus:"none",sourcePage:1};
 assert.deepEqual(preserveDocumentWorkStatuses(prior,{sourcePage:2}),{...prior,sourcePage:2});
 assert.deepEqual(preserveDocumentWorkStatuses(prior,{manualWorkStatus:"unknown",sourcePage:2}),{...prior,manualWorkStatus:"unknown",sourcePage:2});
 assert.deepEqual(preserveDocumentWorkStatuses(undefined,{}),{});
});
