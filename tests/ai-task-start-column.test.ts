import assert from "node:assert/strict";
import test from "node:test";
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
