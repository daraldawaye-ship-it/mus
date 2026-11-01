import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { presenceDate, sinceText } from "../apps/web/src/presence-format.ts";

test("elapsed presence is reported by minutes, hours and days", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.equal(sinceText("2026-11-02T11:59:45Z",now),"الآن");
  assert.equal(sinceText("2026-11-02T11:47:00Z",now),"منذ 13 دقيقة");
  assert.equal(sinceText("2026-11-02T09:05:00Z",now),"منذ 2 ساعة");
  assert.equal(sinceText("2026-10-30T12:00:00Z",now),"منذ 3 يوم");
  assert.equal(sinceText(null,now),"لا يوجد سجل بعد");
  assert.equal(presenceDate(null),"—");
});

test("public presence has explicit administration authorization and throttled signal", () => {
  const route = readFileSync("apps/api/src/routes-public.ts","utf8");
  const heartbeat = readFileSync("apps/web/src/PresenceHeartbeat.tsx","utf8");
  assert.match(route,/router\.get\("\/users\/last-present"/);
  assert.match(route,/publicAdmin\(actor\(req\)\)/);
  const recorder = readFileSync("apps/api/src/services/user-presence.ts","utf8");
  const app = readFileSync("apps/api/src/app.ts","utf8");
  const auth = readFileSync("apps/api/src/services/auth.ts","utf8");
  assert.match(route,/recordUserPresence\(pool, user.id\)/);
  assert.match(recorder,/INSERT INTO user_presence\(user_id,last_seen_at\)/);
  assert.match(recorder,/50 seconds/);
  assert.match(recorder,/60_000/);
  assert.match(recorder,/req\.auth\?\.user\.id/);
  assert.match(app,/trackAuthenticatedPresence\(pool\)/);
  assert.match(auth,/recordUserPresence\(db, userId\)/);
  assert.match(heartbeat,/isOfflineNow\(\)/);
  assert.match(heartbeat,/document.visibilityState !== "visible"/);
  assert.match(heartbeat,/5 \* 60_000/);
  assert.match(heartbeat,/65_000/);
});

test("company presence uses attendance punches, respects company manager authorization", () => {
  const route = readFileSync("apps/api/src/routes-attendance.ts","utf8");
  const ui = readFileSync("apps/web/src/pages/AttendancePage.tsx","utf8");
  assert.match(route,/base \+ "\/currently-present"/);
  assert.match(route,/if \(!context.general\) deny/);
  assert.match(route,/r.checked_out_at IS NULL/);
  assert.match(route,/ORDER BY \(active.checked_in_at IS NOT NULL\) DESC/);
  assert.match(route,/last_checked_out_at/);
  assert.match(ui,/view === "current" && context.general/);
  assert.match(ui,/المحضرون حاليًا/);
});

test("general last present is routed only through public users permissions", () => {
  const app = readFileSync("apps/web/src/App.tsx","utf8");
  const page = readFileSync("apps/web/src/pages/LastPresentUsersPage.tsx","utf8");
  assert.match(app,/path="\/users\/last-present"/);
  assert.match(app,/pageKey="public.last-present"/);
  assert.match(app,/<PresenceHeartbeat userId=\{user\?\.id \?\? null\}/);
  assert.match(page,/title="آخر المتواجدين"/);
  assert.match(page,/sinceText\(row.lastSeenAt, now\)/);
});

test("global last-present includes company activity even on older installed clients", async () => {
  const { trackAuthenticatedPresence } = await import("../apps/api/src/services/user-presence.ts");
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const pool = { query: (sql: string, args: unknown[]) => {
    writes.push({ sql, args });
    return Promise.resolve({ rows: [], rowCount: 1 });
  } };
  const middleware = trackAuthenticatedPresence(pool as never);
  const next = () => {};
  for (const path of ["/companies/2/items", "/companies/2/sales", "/users"]) {
    middleware({ auth: { user: { id: 12345 } }, path } as never, {} as never, next);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1, "one activity write, not three queries");
  assert.deepEqual(writes[0]!.args, [12345]);
  assert.match(writes[0]!.sql, /INSERT INTO user_presence/);
});
