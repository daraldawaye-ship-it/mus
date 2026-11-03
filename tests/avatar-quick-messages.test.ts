import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { quickMessageSchema } from "../apps/api/src/routes-quick-messages.ts";

const read=(path:string)=>readFileSync(path,"utf8");
const uuid="c3dc1df6-4018-4a91-92bd-58a4be985bef";

test("five options have proper company/public boundaries and require actual text", () => {
  for (const kind of ["system_change","present_employees","all_employees"] as const) {
    assert.equal(quickMessageSchema.safeParse({kind,text:"اختبار",clientRequestId:uuid}).success,false);
    assert.equal(quickMessageSchema.safeParse({kind,companyId:2,text:"اختبار",clientRequestId:uuid}).success,true);
  }
  assert.equal(quickMessageSchema.safeParse({kind:"app_manager",text:"مرحبا",clientRequestId:uuid}).success,true);
  assert.equal(quickMessageSchema.safeParse({kind:"private_note",title:"عنوان",text:"نص",clientRequestId:uuid}).success,true);
  assert.equal(quickMessageSchema.safeParse({kind:"private_note",text:"نص",clientRequestId:uuid}).success,false);
  assert.equal(quickMessageSchema.safeParse({kind:"all_employees",companyId:2,text:"  ",clientRequestId:uuid}).success,false);
  assert.equal(quickMessageSchema.safeParse({kind:"all_employees",companyId:2,text:"نص",clientRequestId:uuid,recipientIds:[22]}).success,false,"client cannot inject recipients");
});

test("avatar plus appears before footer actions; company options require membership", () => {
  const menu=read("apps/web/src/UserMenu.tsx");
  const composer=read("apps/web/src/UserMenuQuickCompose.tsx");
  const css=read("apps/web/src/user-menu-tabs.css");
  for(const expected of ["إضافة طلب تعديل النظام","رسالة لجميع المحضّرين","رسالة لجميع الموظفين","رسالة إلى مسؤول التطبيق","مذكرة خاصة بي"])
    assert.ok(composer.includes(expected),expected);
  assert.ok(menu.includes("user-menu-quick-add"));
  assert.ok(menu.includes("setQuickOptionsOpen"));
  assert.ok(menu.includes("!!companyId && (!!employeeId || user.owner)"));
  assert.ok(menu.indexOf('className="user-menu-quick-add"')<0, "button uses shared styling");
  assert.match(menu,/user-menu-tabs-footer user-menu-settings-actions/);
  assert.ok(css.includes(".user-menu-quick-options"));
  assert.ok(css.includes("bottom: 46px"));
  assert.ok(css.includes(".user-menu-settings-actions > .user-menu-quick-add"));
});

test("broadcast targets server-derived actual attendance or all active company employees and avoids self", () => {
  const route=read("apps/api/src/routes-quick-messages.ts");
  assert.match(route,/attendance_records ar/);
  assert.match(route,/ar\.checked_out_at IS NULL/);
  assert.match(route,/e\.company_id=\$1 AND e\.active/);
  assert.match(route,/e\.user_id<>\$2/);
  assert.match(route,/NOT u\.archived AND NOT u\.suspended/);
  assert.match(route,/await companyAccess\(client,user,input\.companyId!\)/);
  assert.match(route,/owner OR kind='admin'/);
  assert.match(route,/AND id<>\$1/);
  assert.match(route,/companyScoped=input.kind/);
});

test("quick broadcasts create independent notifications only, never chat messages", () => {
  const route=read("apps/api/src/routes-quick-messages.ts");
  const notifications=read("apps/api/src/services/notifications.ts");
  assert.match(route,/await emitNotification\(client/);
  assert.match(route,/recipientUserId:recipient.userId,explicitSubjectOnly:true/);
  assert.match(route,/subjectEmployeeId:recipient.employeeId/);
  assert.match(route,/subjectUserId:recipient.userId/);
  assert.match(route,/subjectKey:"quick:"\+user.id\+":"\+input.clientRequestId/);
  assert.match(route,/pg_advisory_xact_lock/);
  assert.match(route,/user_quick_messages/);
  assert.doesNotMatch(route,/sendChatMessage|chatMessages|chat_conversations|CHAT_DIRECT|\/chat"/);
  assert.match(notifications,/export async function emitNotification/);
});

test("private notes are owner-scoped; no content in notifications or shared audit", () => {
  const route=read("apps/api/src/routes-quick-messages.ts");
  const migration=read("apps/api/migrations/20261102_avatar_quick_messages.sql");
  assert.match(route,/user_private_notes WHERE user_id=\$1 AND client_request_id=\$2/);
  assert.match(route,/INSERT INTO user_private_notes\(user_id,client_request_id,title,body\)/);
  assert.match(route,/quick\.privateNoteCreate/);
  assert.match(migration,/UNIQUE\(user_id,client_request_id\)/);
  assert.match(migration,/user_private_notes_owner_date/);
  assert.doesNotMatch(route,/GET.*user_private_notes/);
});

test("endpoint is registered and an on-site developer guide entry is deployed with the schema", () => {
  const app=read("apps/api/src/app.ts");
  const migration=read("apps/api/migrations/20261102_avatar_quick_messages.sql");
  assert.match(app,/quickMessagesRoutes\(pool\)/);
  assert.match(migration,/developer-avatar-quick-message-20261102/);
});

test("all quick-message and private-note modals close on submit without a success modal", () => {
  const modal=read("apps/web/src/UserMenuQuickCompose.tsx");
  const app=read("apps/web/src/App.tsx");
  const delivery=read("apps/web/src/QuickMessageDelivery.tsx");
  assert.match(modal,/queueQuickMessageDelivery\(payload,user\.id,queryClient\);\s*onClose\(\)/);
  assert.doesNotMatch(modal,/setResult\(|<Notice>\{privateNote/);
  assert.match(app,/<QuickMessageDeliveryStatus userId=\{user\?\.id \?\? null\}/);
  assert.match(delivery,/api\("\/quick-messages",\{method:"POST",body:item\.request\}\)/);
  assert.match(delivery,/retryQuickMessageDelivery\(job\.id,userId\)/);
  assert.match(delivery,/clientRequestId/);
  assert.match(delivery,/status==="failed"/);
  assert.match(delivery,/invalidateQueries\(\{queryKey:\["private-notes"\]\}\)/);
  assert.doesNotMatch(delivery,/localStorage|sessionStorage/);
});
