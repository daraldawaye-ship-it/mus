import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { listQuery } from "../apps/api/src/services/lists.ts";

test("user activity is throttled at both foreground client and DB, not every API call", () => {
  const frontend = readFileSync("apps/web/src/PresenceHeartbeat.tsx","utf8");
  const server = readFileSync("apps/api/src/services/user-device-activity.ts","utf8");
  const routes = readFileSync("apps/api/src/routes-public.ts","utf8");
  const migration = readFileSync("apps/api/migrations/20261102_user_device_last_activity.sql","utf8");
  assert.match(frontend, /intervalMs = 5 \* 60_000/);
  assert.match(frontend, /now - lastSent < intervalMs/);
  assert.match(frontend, /lastInteraction - lastSent >= intervalMs/);
  assert.match(frontend, /document\.visibilityState !== "visible"/);
  assert.match(server, /last_activity_at <= clock_timestamp\(\)-interval '5 minutes'/);
  assert.match(server, /ON CONFLICT\(user_id,device_kind\) DO UPDATE/);
  assert.match(routes, /await recordDeviceActivity\(pool,user\.id,requestDevice\(req\)\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS last_activity_at timestamptz/);
  assert.doesNotMatch(frontend, /lastLoginAt/);
});

test("each device's activity is different from its login and must be server sorted", () => {
  const routes = readFileSync("apps/api/src/routes-public.ts","utf8");
  const users = readFileSync("apps/web/src/pages/PublicPages.tsx","utf8");
  for (const kind of ["desktop_browser","mobile_browser","android_app","iphone_app"]) {
    assert.ok(routes.includes(`"device-activity-${kind}"`));
    assert.ok(users.includes(`id: \`device-activity-\${kind}\``));
  }
  assert.match(routes, /SELECT a\.last_activity_at FROM user_device_activity/);
  assert.match(routes, /lastActivityAt: item\.last_activity_at/);
  assert.match(users, /\.lastActivityAt/);
  assert.doesNotMatch(users, /deviceActivity\?\.\[kind\]\?\.lastLoginAt/);
  assert.match(users, /enableSorting: true/);
  assert.match(routes, /"app-push"/);
  assert.match(routes, /"laptop-push"/);
});

test("trusted user sort fields preserve nulls last and server pagination", () => {
  const keys = {id:"id", "device-activity-android_app":"(SELECT a.last_activity_at FROM user_device_activity a WHERE a.user_id=users.id AND a.device_kind='android_app')"};
  const nulls = new Set(["device-activity-android_app"]);
  const asc = listQuery({sort:"device-activity-android_app:asc",page:"2",pageSize:"20"},keys,"id:asc",nulls);
  const desc = listQuery({sort:"device-activity-android_app:desc"},keys,"id:asc",nulls);
  assert.match(asc.order,/ASC NULLS LAST, id ASC$/);
  assert.match(desc.order,/DESC NULLS LAST, id ASC$/);
  assert.equal(asc.offset,20);
  assert.throws(()=>listQuery({sort:"device-activity-android_app:desc;DROP TABLE users"},keys,"id:asc",nulls));
});
