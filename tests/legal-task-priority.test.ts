import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateLegalTaskPriority,
  compareLegalTasks,
  type TaskPriorityInput,
} from "../apps/api/src/legal-task-priority.ts";

const now=Date.parse("2026-10-24T09:00:00Z");
const task:TaskPriorityInput={
  title:"متابعة عادية",body:"",status:"pending",due_at:null,
  task_priority:null,task_priority_reason:"",
};

test("automatic urgency follows stored deadlines while a manual override stays explicit",()=>{
  assert.equal(calculateLegalTaskPriority(task,now).priority,9);
  assert.equal(calculateLegalTaskPriority({...task,due_at:"2026-10-24T08:59:59Z"},now).priority,2);
  assert.equal(calculateLegalTaskPriority({...task,next_hearing:"2026-10-25"},now).priority,3);
  assert.equal(calculateLegalTaskPriority({...task,due_at:"2026-10-29T09:00:00Z"},now).priority,5);
  assert.equal(calculateLegalTaskPriority({...task,due_at:"2026-11-24T09:00:00Z"},now).priority,9);
  const manual=calculateLegalTaskPriority({
    ...task,due_at:"2026-10-24T08:59:59Z",task_priority:7,task_priority_reason:"تأجيل معتمد",
  },now);
  assert.deepEqual(manual,{priority:7,reason:"تأجيل معتمد",source:"manual"});
  assert.equal(calculateLegalTaskPriority({...task,status:"verified",due_at:"2000-01-01"},now).priority,9);
});

test("task priority ordering uses hearing dates, keeps completed tasks last and breaks ties deterministically",()=>{
  const base={status:"pending",priority:4,sort_order:0,due_at:null};
  const ordered=[
    {...base,id:1},
    {...base,id:2},
    {...base,id:3,sort_order:1},
    {...base,id:4,next_hearing:"2026-10-27"},
    {...base,id:5,due_at:new Date("2026-10-26T09:00:00Z")},
    {...base,id:6,priority:1,status:"verified"},
    {...base,id:7,priority:2},
  ].sort(compareLegalTasks);
  assert.deepEqual(ordered.map(row=>row.id),[7,5,4,2,1,3,6]);
});
