import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { quickMessageSchema, quickNotificationTypes } from "../apps/api/src/routes-quick-messages.ts";
const read=(path:string)=>readFileSync(path,"utf8");

test("four independent alert types show the requested type, not the sender as title",()=>{
  assert.deepEqual(quickNotificationTypes,{
    system_change:{code:"QUICK_SYSTEM_CHANGE",title:"طلب تعديل النظام"},
    present_employees:{code:"QUICK_PRESENT_EMPLOYEES",title:"رسالة إلى جميع المحضّرين"},
    all_employees:{code:"QUICK_ALL_EMPLOYEES",title:"رسالة إلى جميع الموظفين"},
    app_manager:{code:"QUICK_APP_MANAGER",title:"رسالة إلى مسؤول التطبيق"},
  });
  const sql=read("apps/api/migrations/20261102_quick_notifications_only.sql");
  for(const entry of Object.values(quickNotificationTypes)){
    assert.ok(sql.includes("'"+entry.code+"'"),entry.code+" in migration");
    assert.ok(sql.includes("'"+entry.title+"'"),entry.title+" in migration");
  }
});
test("recipient targeting and message content live in notifications alone",()=>{
  const route=read("apps/api/src/routes-quick-messages.ts");
  assert.ok(route.includes("emitNotification(client,{"));
  assert.ok(route.includes('message:notificationText'));
  assert.ok(route.includes('":\\n"+input.text'));
  assert.ok(route.includes('title:type.title'));
  assert.ok(route.includes('href:destination'));
  assert.ok(route.includes('recipientUserId:recipient.userId'));
  assert.ok(route.includes('subjectUserId:recipient.userId'));
  assert.ok(route.includes('subjectEmployeeId:recipient.employeeId'));
  assert.ok(route.includes('explicitSubjectOnly:true'));
  assert.ok(route.includes("attendance_records ar"));
  assert.ok(route.includes("ar.checked_out_at IS NULL"));
  assert.ok(route.includes("AND e.active AND e.user_id<>$2"));
  assert.ok(route.includes("owner OR kind='admin'"));
  assert.ok(route.includes("LIMIT 251"));
  assert.ok(route.includes("recipients.length>250"));
  assert.ok(route.includes("user_quick_messages"));
  assert.ok(route.includes("pg_advisory_xact_lock"));
  assert.doesNotMatch(route,/sendChatMessage|chat_messages|chat_conversations|notifyChatRecipient|CHAT_DIRECT|chat\\.send/);
  assert.doesNotMatch(route,/href:\\s*["']?\/chat/);
});
test("recipient inbox is visible without chat page permission, company ID scopes preserved",()=>{
  const notificationCore=read("apps/api/src/services/notifications.ts");
  const inbox=read("apps/api/src/routes-notifications.ts");
  const route=read("apps/api/src/routes-quick-messages.ts");
  assert.ok(notificationCore.includes("export async function emitNotification"));
  assert.ok(notificationCore.includes("input.subjectUserId ?? null"));
  assert.ok(notificationCore.includes("input.recipientUserId ?? null"));
  assert.ok(notificationCore.includes("explicitSubjectOnly"));
  assert.ok(inbox.includes('base + "/notifications"'));
  assert.ok(route.includes('"/companies/"+input.companyId+"/notifications?state=all&grouped=0&code="'));
  assert.ok(route.includes('"/notifications?state=all&grouped=0&code="'));
});
test("preview and full notifications show complete text in alerts",()=>{
  const bell=read("apps/web/src/NotificationBell.tsx");
  const page=read("apps/web/src/pages/NotificationsPage.tsx");
  const css=read("apps/web/src/styles.css");
  assert.ok(bell.includes('record.code.startsWith("QUICK_")'));
  assert.ok(page.includes('record.code.startsWith("QUICK_")'));
  assert.ok(css.includes(".notification-quick-item.is-quick-message .notification-quick-message"));
  assert.ok(css.includes("white-space: pre-wrap"));
  assert.ok(css.includes("-webkit-line-clamp: unset"));
  assert.ok(css.includes(".notification-record.is-quick-message .notification-message"));
  assert.ok(bell.includes("{record.message}"));
  assert.ok(page.includes("{record.message}"));
});
test("normal private chat code has not changed and retains generic private alerts",()=>{
  const code=read("apps/api/src/services/chat.ts");
  const notify=read("apps/api/src/services/chat-notifications.ts");
  assert.ok(code.includes("await notifyChatRecipient(client"));
  assert.ok(notify.includes("أرسل إليك رسالة خاصة جديدة"));
  assert.doesNotMatch(notify,/QUICK_(?:PRESENT|ALL|SYSTEM|APP)/);
  assert.doesNotMatch(code,/QUICK_(?:PRESENT|ALL|SYSTEM|APP)/);
  const composer=read("apps/web/src/UserMenuQuickCompose.tsx");
  assert.ok(composer.includes("دون دردشة"));
  assert.equal(quickMessageSchema.safeParse({
    kind:"all_employees",companyId:2,text:"مرحباً",clientRequestId:"550e8400-e29b-41d4-a716-446655440000",
  }).success,true);
});
