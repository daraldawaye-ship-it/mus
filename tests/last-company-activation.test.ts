import test from "node:test";
import assert from "node:assert/strict";
import { enqueueCompanyActivation } from "../apps/web/src/last-company-activation.ts";

test("last company visit is persisted even if user leaves the company page immediately", async () => {
  const queue = {current: Promise.resolve()};
  const visited:number[] = [];
  let finishFirst!: () => void;
  const firstGate = new Promise<void>(resolve => {finishFirst=resolve;});
  const first = enqueueCompanyActivation(queue, async () => {
    await firstGate;
    visited.push(11);
  });
  // Simulates opening a second company before the previous visit has saved.
  const second = enqueueCompanyActivation(queue, async () => {
    visited.push(22);
  });
  await Promise.resolve();
  assert.deepEqual(visited,[], "Second activation waits for the first visit");
  finishFirst();
  await Promise.all([first,second]);
  assert.deepEqual(visited,[11,22], "The last visited company must win");
});

test("failed activation never blocks a later accessible company visit", async () => {
  const queue = {current: Promise.resolve()};
  const visits:number[]=[];
  const denied=enqueueCompanyActivation(queue,async () => {
    throw new Error("Previous company membership was revoked");
  });
  const accessible=enqueueCompanyActivation(queue,async () => {
    visits.push(45);
  });
  await assert.rejects(denied,/membership was revoked/);
  await accessible;
  assert.deepEqual(visits,[45]);
});

test("quick return to public pages cannot cancel last-company activation", async () => {
  const queue={current:Promise.resolve()};
  const seen:number[]=[];
  // No AbortSignal or route cleanup is passed to this queued persistence task.
  const visited=enqueueCompanyActivation(queue,async () => {
    await Promise.resolve();
    seen.push(77);
  });
  // A route cleanup does not touch the queue.
  await visited;
  assert.deepEqual(seen,[77]);
});
