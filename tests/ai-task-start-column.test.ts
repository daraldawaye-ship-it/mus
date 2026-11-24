import assert from "node:assert/strict";
import test from "node:test";
import { isAiTaskJournalArchive, pageAiTaskHistory } from "../apps/api/src/services/ai-task-history-page.ts";
import { taskDTO } from "../apps/api/src/routes-ai-tasks.ts";

const row = {
  task_id: 434,
  task_created_at: new Date("2026-11-08T01:02:03Z"),
  updated_at: new Date("2026-11-20T10:00:00Z"),
  general_table_title: "صندوقي",
  general_table_description: "متابعة",
  general_table_category: "الشركة",
  general_table_text7: "",
  general_table_text8: "",
  general_table_text9: "",
  section: "الشركة",
  company_id: 2,
  cadence_hours: 8,
};
const ended = {
  id: 1, title: "جولة سابقة", detail: "اكتملت الجولة السابقة",
  startedAt: null, finishedAt: "2026-11-20T10:00:00.000Z",
  recordedAt: "2026-11-20T10:00:00.000Z", resumeFrom: null,
};

test("new AI task run shows actual start and its own active note before any finish", () => {
  const result = taskDTO({
    ...row,
    general_table_text8: JSON.stringify({
      taskId: 434, runId: "run-434", startedAt: "2026-11-20T22:21:31+03:00",
      status: "started",
    }),
    general_table_text9: "بدأت جولة يدوية بطلب المالك.",
  }, []);
  assert.equal(result.lastStartedAt, "2026-11-20T19:21:31.000Z");
  assert.equal(result.lastFinishedAt, null);
  assert.equal(result.latestRunInProgress, true);
  assert.equal(result.lastResult, "بدأت جولة يدوية بطلب المالك.");
  assert.equal(result.nextEligibleAt, "2026-11-21T03:21:31.000Z");
  assert.equal(result.createdAt, "2026-11-08T01:02:03.000Z");
  assert.equal(result.lastRunDurationSeconds, null);
});

test("new active note does not borrow a prior finish or previous result", () => {
  const result = taskDTO({
    ...row,
    general_table_text8: JSON.stringify({ taskId: 434, startedAt: "2026-11-20T19:21:31Z", status: "started" }),
  }, [ended]);
  assert.equal(result.lastFinishedAt, ended.finishedAt);
  assert.equal(result.lastResult, "بدأت الجولة");
  assert.equal(result.latestRunInProgress, true);
  assert.equal(result.lastRunDurationSeconds, null);
});

test("completed metadata retains actual start and distinct finish; legacy has finish only", () => {
  const legacy = taskDTO(row, [ended]);
  assert.equal(legacy.lastStartedAt, null);
  assert.equal(legacy.lastFinishedAt, ended.finishedAt);
  assert.equal(legacy.latestRunInProgress, false);
  assert.equal(legacy.lastRunDurationSeconds, null);
  const result = taskDTO({
    ...row,
    general_table_text8: JSON.stringify({
      taskId: 434, startedAt: "2026-11-20T19:21:31Z", endedAt: "2026-11-20T19:42:00Z", status: "completed",
    }),
    general_table_text9: "انتهت المراجعة.",
  }, [ended]);
  assert.equal(result.lastStartedAt, "2026-11-20T19:21:31.000Z");
  assert.equal(result.lastFinishedAt, "2026-11-20T19:42:00.000Z");
  assert.equal(result.latestRunInProgress, false);
  assert.equal(result.lastResult, "انتهت المراجعة.");
  assert.equal(result.nextEligibleAt, "2026-11-21T03:21:31.000Z");
  assert.equal(result.lastRunDurationSeconds, 1229);
});

test("legacy recording time does not substitute for the actual finish", () => {
  const start = "2026-11-20T09:59:00.000Z";
  assert.equal(taskDTO(row, [{ ...ended, startedAt: start }]).lastRunDurationSeconds, null);
  assert.equal(taskDTO(row, [{ ...ended, startedAt: start, durationSeconds: 60 }]).lastRunDurationSeconds, 60);
});

test("newer archive of the same finish cannot become last result or resume cursor", () => {
  const startedAt = "2026-11-20T09:59:00.000Z";
  const real = {...ended,startedAt,durationSeconds:60,resumeFrom:"real cursor"};
  const archived = {...real,id:2,title:"حفظ حرفي لسجل المهمة #434",detail:"verbatim archive",recordedAt:"2026-11-21T00:00:00.000Z",
    resumeFrom:"archive cursor",archiveReceipt:isAiTaskJournalArchive("أرشيف تاريخ مهمة 434","حفظ حرفي لسجل المهمة #434")};
  assert.equal(archived.archiveReceipt,true);
  assert.deepEqual(taskDTO(row,[archived,real]),taskDTO(row,[real]));
  assert.equal(taskDTO(row,[archived,real]).lastResult,real.detail);
  assert.equal(taskDTO(row,[archived,real]).resumeFrom,real.resumeFrom);
  assert.equal(taskDTO(row,[archived,real]).nextEligibleAt,"2026-11-20T17:59:00.000Z");
  const older=pageAiTaskHistory([archived,real],"older",1,null);
  assert.deepEqual(older.history.map(receipt=>[receipt.id,receipt.detail,receipt.historical]),[[2,"verbatim archive",true]]);
});

test("archived starts and later finish cannot override a started real run; real legacy receipts remain", () => {
  const startedAt="2026-11-20T19:21:31.000Z";
  const active={...ended,id:3,startedAt,finishedAt:null,detail:"real active"};
  const archive={...ended,id:4,startedAt:"2026-11-22T09:00:00.000Z",finishedAt:"2026-11-22T11:00:00.000Z",durationSeconds:7200,archiveReceipt:true};
  const archiveStart={...archive,id:5,finishedAt:null};
  const legacy={...ended,title:"مطابقة أوراق تاريخية",archiveReceipt:isAiTaskJournalArchive("تنفيذ دوري","مطابقة أوراق تاريخية")};
  assert.equal(legacy.archiveReceipt,false);
  const live=taskDTO(row,[archiveStart,archive,active,legacy]);
  assert.equal(live.lastStartedAt,startedAt);
  assert.equal(live.lastFinishedAt,legacy.finishedAt);
  assert.equal(live.latestRunInProgress,true);
  assert.equal(live.lastResult,"بدأت الجولة: real active");
  assert.equal(live.nextEligibleAt,"2026-11-21T03:21:31.000Z");
  const finished={...active,finishedAt:"2026-11-20T19:22:31.000Z",durationSeconds:60,detail:"real finished"};
  assert.equal(taskDTO(row,[archive,finished,legacy]).lastResult,"real finished");
  assert.equal(taskDTO(row,[archive,finished,legacy]).lastRunDurationSeconds,60);
});
