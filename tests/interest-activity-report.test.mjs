import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const src=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("activity detail is isolated, owner-only, no-preview and private",()=>{
  const api=src("apps/api/src/routes-interest-events.ts");
  const block=api.split('router.get("/interest-events/activity"')[1].split('router.get("/interest-events/report"')[0];
  assert.match(block,/X-Alraesy-Employee-Preview[\s\S]*ownerOnly\(user\)[\s\S]*parse\(activityQuerySchema,req.query\)/);
  assert.match(block,/private, no-store/);
  assert.match(block,/activityPageSize\+1/);
  assert.match(api,/const activityPageSize=30/);
  assert.match(api,/employee.company_id=i.target_id[\s\S]*context->>'employeeId'/);
  assert.match(api,/CASE WHEN e.action='operator_activity' THEN e.label::jsonb ELSE NULL END/);
  assert.match(api,/\(\$2::date\+1\)::timestamp AT TIME ZONE 'Asia\/Aden'/);
  assert.match(api,/\(e.occurred_at,e.id\)<\(\$6::timestamptz,\$7::bigint\)/);
  assert.match(api,/ORDER BY identified.occurred_at DESC,identified.id DESC/);
  assert.match(api,/^(?!.*DELETE).*router.get\("\/interest-events\/activity"/m);
});

test("the screen replaces the old recent cap with cursor navigation without changing aggregate endpoint",()=>{
  const ui=src("apps/web/src/pages/InterestStatisticsPage.tsx");
  assert.doesNotMatch(ui,/أحدث 100 حركة مسجلة/);
  assert.match(ui,/\/interest-events\/report\?days=/);
  assert.match(ui,/اسم الموظف/);
  assert.match(ui,/اسم حساب المستخدم/);
  assert.match(ui,/setCursors\(\[null\]\);setFilters/);
  assert.match(ui,/params.set\("cursorAt",cursor.at\);params.set\("cursorId",cursor.id\)/);
  assert.match(ui,/enabled:!!user\?\.owner/);
  assert.match(ui,/onClick=\{refresh\}>تحديث/);
  assert.match(ui,/invalidateQueries\(\{queryKey:\["interest-events-activity",user\?\.id\][\s\S]+setCursors\(\[null\]\)/);
});
