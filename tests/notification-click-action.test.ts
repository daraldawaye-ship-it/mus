import assert from "node:assert/strict";
import test from "node:test";
import { notificationClickAction } from "../apps/web/src/notification-click-action.ts";
import { notificationActionSchema } from "../packages/contracts/src/notifications.ts";

const primaryClick = { defaultPrevented: false, button: 0, altKey: false,
  ctrlKey: false, metaKey: false, shiftKey: false };
const notification = {id: 81, revision: 2, companyId: 7, completedAt: null, completeOnClick: true};

test("ordinary click completes only the exact alert in its own scope", () => {
  const company = notificationClickAction(notification, primaryClick);
  assert.deepEqual(company, {
    path: "/companies/7/notifications/81/action",
    body: { action: "complete", revision: 2, onClick: true },
  });
  assert.deepEqual(notificationActionSchema.parse(company?.body), company?.body);
  assert.equal(notificationClickAction({...notification, companyId: null}, primaryClick)?.path, "/notifications/81/action");
});

test("disabled, finished, alternate or already handled clicks do not complete", () => {
  for (const record of [{...notification, completeOnClick: false}, {...notification, completedAt: "2026-11-15"}])
    assert.equal(notificationClickAction(record, primaryClick), undefined);
  for (const change of [{button: 1}, {altKey: true}, {shiftKey: true}, {metaKey: true}, {ctrlKey: true}, {defaultPrevented: true}])
    assert.equal(notificationClickAction(notification, {...primaryClick, ...change}), undefined);
});
