import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { notifyChatRecipient } from "../apps/api/src/services/chat-notifications.ts";
import { companyOnlyInboxFilter, effectiveTemplate, emitNotification, inboxFilter, latestStream } from "../apps/api/src/services/notifications.ts";

test("chat notification streams consolidate old and new rows by room, with scope and type isolation", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE users(id int PRIMARY KEY, archived boolean, owner boolean);
    INSERT INTO users VALUES (1,false,false),(2,false,false);
    CREATE TABLE employees(id int,company_id int,user_id int,active boolean,position_keys text[],role text);
    INSERT INTO employees VALUES(22,2,1,true,'{}','employee'),(23,3,1,true,'{}','employee');
    CREATE TABLE page_settings(company_id int,enabled boolean,page_key text);
    CREATE TABLE company_roles(id int,company_id int,active boolean,key text);
    CREATE TABLE employee_role_assignments(employee_id int,company_id int,role_id int,active boolean);
    CREATE TABLE memos(id int,company_id int,status text,current_user_id int,current_employee_id int);
    CREATE TABLE memo_followers(company_id int,memo_id int,employee_id int,role_id int);
    CREATE TABLE chat_groups(id int,company_id int);
    CREATE TABLE chat_group_members(group_id int,user_id int,left_at timestamptz,joined_after_message_id int);
    CREATE TABLE chat_group_messages(group_id int,id int);
    INSERT INTO chat_groups VALUES (80,2),(81,2),(82,NULL),(83,3);
    INSERT INTO chat_group_members VALUES(80,1,NULL,0),(81,1,NULL,0),(82,1,NULL,0),(83,1,NULL,0),(80,2,NULL,0);
    INSERT INTO chat_group_messages VALUES(80,11),(80,12),(80,13),(80,14),(81,21),(82,31),(83,41);
    CREATE TABLE notification_settings(id int,company_id int,code text,revision int,importance text,enabled boolean,
      can_snooze boolean,allow_repeat boolean,repeat_interval text,notify_managers boolean,notify_owner boolean,
      reviewed boolean,notify_subject boolean,position_keys text[],min_interval_hours int,latest_only boolean,employee_ids int[]);
    CREATE TABLE notification_templates(code text,scope text,implemented boolean,default_importance text,
      default_notify_managers boolean,default_position_keys text[],default_latest_only boolean);
    INSERT INTO notification_templates VALUES
      ('CHAT_GROUP_COMPANY','company',true,'high',false,'{}',false),
      ('CHAT_GROUP_GLOBAL','public',true,'high',false,'{}',true),
      ('CHAT_DIRECT_COMPANY','company',true,'high',false,'{}',true),
      ('QUICK_ALL_EMPLOYEES','company',true,'high',false,'{}',true);
    CREATE TABLE notifications (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id int,code text,recipient_user_id int,
      subject_employee_id int,subject_key text,event_key text,title text,message text,importance text,href text,
      repeat_interval text,next_reminder_at timestamptz,created_at timestamptz,assigned boolean,stream_key text,
      silent_update boolean,read_at timestamptz,snoozed_until timestamptz,delivery_id int,completed_at timestamptz,
      revision int DEFAULT 1, updated_at timestamptz,last_reminded_at timestamptz);
    CREATE TABLE audit_events(actor_id int,actor_name text,scope text,company_id int,action text,target_type text,
      target_id int,before_value jsonb,after_value jsonb);
  `);
  const client = {query: async (sql: string, params?: unknown[]) => {
    const result = await db.query(sql, params);
    return {...result, rowCount: result.rows.length};
  }} as unknown as PoolClient;
  // Apply the actual migration instead of mirroring the new field in this fixture.
  await db.exec(await readFile(new URL("../apps/api/migrations/20261115_notification_complete_on_click.sql", import.meta.url), "utf8"));
  assert.equal((await effectiveTemplate(client, 2, "CHAT_GROUP_COMPANY"))?.completeOnClick, true);
  assert.equal((await effectiveTemplate(client, null, "CHAT_GROUP_GLOBAL"))?.completeOnClick, true);
  assert.equal((await effectiveTemplate(client, 2, "QUICK_ALL_EMPLOYEES"))?.completeOnClick, false);
  await db.exec("INSERT INTO notification_settings(company_id,code,complete_on_click) VALUES (3,'CHAT_GROUP_COMPANY',false), (3,'QUICK_ALL_EMPLOYEES',true)");
  assert.equal((await effectiveTemplate(client, 3, "CHAT_GROUP_COMPANY"))?.completeOnClick, false);
  assert.equal((await effectiveTemplate(client, 3, "QUICK_ALL_EMPLOYEES"))?.completeOnClick, true);
  await db.exec("DELETE FROM notification_settings WHERE company_id=3");
  const group = (companyId: number | null, groupId: number, senderId: number, messageId: number, recipientId = 1) =>
    notifyChatRecipient(client, {companyId, groupId, senderId, messageId, recipientId, senderName: "Sender"});
  const direct = (senderId: number, messageId: number) =>
    notifyChatRecipient(client, {companyId: 2, senderId, messageId, recipientId: 1, senderName: "Sender"});
  const quick = (senderId: number) => emitNotification(client, {
    code: "QUICK_ALL_EMPLOYEES", companyId: 2, subjectEmployeeId: 22, explicitSubjectOnly: true,
    subjectKey: "quick:" + senderId, eventKey: "quick:" + senderId, streamKey: "sender:" + senderId, message: "Quick message",
  });
  const list = async (companyId: number | null, viewerId = 1, filter = inboxFilter) =>
    (await db.query<{subject_key: string; stream: string}>(`
      SELECT n.subject_key, ${latestStream} AS stream FROM notifications n
      JOIN notification_templates t ON t.code=n.code
      LEFT JOIN notification_settings s ON s.company_id IS NOT DISTINCT FROM n.company_id AND s.code=n.code
      WHERE ${filter} AND n.completed_at IS NULL ORDER BY n.id
    `, [viewerId, companyId, viewerId === 1 ? 22 : null, true])).rows;

  await group(2, 80, 8, 11);
  await group(2, 80, 9, 12);
  await group(2, 81, 8, 21);
  await group(null, 82, 8, 31);
  await group(3, 83, 8, 41);
  await direct(8, 51);
  await direct(9, 52);
  await quick(8);
  await quick(9);
  await db.exec(`
    UPDATE notifications SET stream_key='group:80:sender:8' WHERE subject_key='chat-group:80:message:11';
    UPDATE notifications SET stream_key='group:80:sender:9' WHERE subject_key='chat-group:80:message:12';
    INSERT INTO notifications(company_id,code,recipient_user_id,subject_key,stream_key,assigned,revision)
      VALUES(2,'CHAT_GROUP_COMPANY',2,'chat-group:80:message:14','group:80:sender:9',true,1);
  `);
  const inRoom = (rows: {subject_key: string}[]) => rows.filter(r => r.subject_key.startsWith("chat-group:80:"));
  assert.equal(inRoom(await list(2)).length, 2, "disabled setting does not hide alerts");
  await db.exec("UPDATE notification_templates SET default_latest_only=true WHERE code='CHAT_GROUP_COMPANY'");
  assert.deepEqual(inRoom(await list(2)), [{subject_key:"chat-group:80:message:12", stream:"group:80"}]);
  await group(2, 80, 8, 13);
  const visible = await list(2);
  assert.deepEqual(inRoom(visible), [{subject_key:"chat-group:80:message:13", stream:"group:80"}]);
  for (const key of ["chat-group:81:message:21", "chat-group:82:message:31", "chat-message:51", "chat-message:52", "quick:8", "quick:9"])
    assert(visible.some(r => r.subject_key === key), `must preserve ${key}`);
  assert(!visible.some(r => r.subject_key.startsWith("chat-group:83:")), "does not expose another company");
  const publicInbox = await list(null);
  const companyInbox = await list(2, 1, companyOnlyInboxFilter);
  assert.deepEqual(publicInbox.map(row => row.subject_key), ["chat-group:82:message:31"]);
  assert.equal(companyInbox.length, visible.length - 1);
  assert(!companyInbox.some(row => row.subject_key.startsWith("chat-group:82:")));
  assert(!companyInbox.some(row => row.subject_key.startsWith("chat-group:83:")));
  assert.equal(inRoom(await list(2, 2)).length, 1, "does not change another recipient");
  const old = await db.query<{completed_at: Date | null}>(`
    SELECT completed_at FROM notifications WHERE recipient_user_id=1
    AND subject_key IN ('chat-group:80:message:11','chat-group:80:message:12')
  `);
  assert.equal(old.rows.length, 2);
  assert(old.rows.every(row => row.completed_at !== null));
});
