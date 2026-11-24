import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { scanInventoryNotifications } from "../apps/api/src/services/inventory-notifications.ts";
import { effectiveTemplate, inboxFilter, refreshNotificationReminders } from "../apps/api/src/services/notifications.ts";

test("reactivation notifies the subscribed owner on new episodes, not migration stock or hidden historical notices", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE companies(id integer PRIMARY KEY);
      CREATE TABLE users(id integer PRIMARY KEY,owner boolean,archived boolean,suspended boolean);
      CREATE TABLE employees(company_id integer,id integer,user_id integer,active boolean,is_general_manager boolean,position_keys text[],role text);
      CREATE TABLE memos(company_id integer,id integer,status text,current_user_id integer,current_employee_id integer);
      CREATE TABLE memo_followers(company_id integer,memo_id integer,employee_id integer,role_id integer);
      CREATE TABLE company_roles(company_id integer,id integer,key text,active boolean);
      CREATE TABLE employee_role_assignments(company_id integer,role_id integer,employee_id integer,active boolean);
      CREATE TABLE chat_group_members(group_id integer,user_id integer,left_at timestamptz,joined_after_message_id integer);
      CREATE TABLE chat_groups(id integer,company_id integer);
      CREATE TABLE chat_group_messages(group_id integer,id integer);
      CREATE TABLE page_settings(company_id integer,page_key text,enabled boolean);
      CREATE TABLE stock_balances(company_id integer,item_id integer,location_id integer,quantity_smallest bigint);
      CREATE TABLE stock_movements(id integer,company_id integer,item_id integer,location_id integer);
      CREATE TABLE items(company_id integer,id integer,active boolean,name text,factor2 integer,factor3 integer,unit1_name text,unit2_name text,unit3_name text,order_alert_quantity numeric);
      CREATE TABLE branches(company_id integer,id integer,active boolean);
      CREATE TABLE locations(company_id integer,id integer,branch_id integer,active boolean,name text);
      CREATE TABLE notification_templates(code text PRIMARY KEY,name text,category text,scope text,description text,
        implemented boolean,can_disable boolean,default_importance text,default_notify_managers boolean,default_position_keys text[],default_latest_only boolean,default_min_interval_hours integer);
      CREATE TABLE notification_settings(id integer,company_id integer,code text,importance text,enabled boolean,can_snooze boolean,
        allow_repeat boolean,repeat_interval text,notify_managers boolean,notify_subject boolean,position_keys text[],
        employee_ids integer[],revision integer,min_interval_hours integer,latest_only boolean,notify_owner boolean,reviewed boolean,complete_on_click boolean);
      CREATE TABLE notifications(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer,code text,recipient_user_id integer,
        subject_employee_id integer,subject_key text,event_key text,title text,message text,importance text,href text,repeat_interval text,
        next_reminder_at timestamptz,created_at timestamptz DEFAULT clock_timestamp(),assigned boolean,stream_key text DEFAULT '',silent_update boolean DEFAULT false,
        read_at timestamptz,snoozed_until timestamptz,delivery_id integer,last_reminded_at timestamptz,completed_at timestamptz,
        revision integer DEFAULT 1,updated_at timestamptz,reminder_count integer DEFAULT 0,
        UNIQUE(company_id,event_key,recipient_user_id));
      CREATE UNIQUE INDEX fixture_pending ON notifications(COALESCE(company_id,0),code,recipient_user_id,subject_key) WHERE completed_at IS NULL;
      CREATE TABLE notification_auto_resolutions(notification_id integer PRIMARY KEY,reason text);
      CREATE TABLE audit_events(actor_id integer,actor_name text,scope text,company_id integer,action text,target_type text,target_id integer,before_value jsonb,after_value jsonb);
      INSERT INTO companies VALUES(2),(3);
      INSERT INTO users VALUES(1,true,false,false),(8,false,false,false);
      INSERT INTO branches VALUES(2,1,true),(3,1,true);
      INSERT INTO locations VALUES(2,1,1,true,'المعرض'),(3,1,1,true,'المعرض');
      INSERT INTO items VALUES(2,10,true,'قديم',1,1,'حبة','','',NULL),(2,20,true,'جديد',1,1,'حبة','','',NULL),
        (2,30,true,'موجب محصّل',1,1,'حبة','','',NULL),(3,10,true,'شركة أخرى',1,1,'حبة','','',NULL);
      INSERT INTO stock_balances VALUES(2,10,1,-4),(2,20,1,0),(2,30,1,-4),(2,30,1,5),(3,10,1,-6);
      INSERT INTO notification_templates VALUES('INVENTORY_NEGATIVE','مخزون صنف أصبح سالبًا','مخزون','company','',true,true,'medium',false,'{}',false,NULL);
      INSERT INTO notification_settings VALUES
        (1,2,'INVENTORY_NEGATIVE','medium',true,true,false,'none',false,false,'{}','{}',4,1,false,true,true,false),
        (2,3,'INVENTORY_NEGATIVE','medium',true,true,false,'none',false,false,'{}','{}',1,null,false,true,true,false);
      INSERT INTO notifications(company_id,code,recipient_user_id,subject_key,event_key,title,message,importance,snoozed_until)
        VALUES(2,'INVENTORY_NEGATIVE',1,'item:10:location:1','INVENTORY_NEGATIVE:item:10:location:1:episode:3','قديم','\u0642\u062f\u064a\u0645','medium',clock_timestamp()-interval '1 minute');
    `);
    const migration = async (name: string) => db.exec(await readFile(new URL("../apps/api/migrations/" + name, import.meta.url),"utf8"));
    await migration("20261112_negative_stock_notification_incidents.sql");
    await db.exec("INSERT INTO negative_stock_notification_incidents(company_id,item_id,location_id,episode,active) VALUES(2,10,1,3,true)");
    const balances = (await db.query("SELECT * FROM stock_balances ORDER BY company_id,item_id,quantity_smallest")).rows;
    await migration("20261124_zz_reactivate_dar_aldawaa_negative_stock_notifications.sql");
    assert.deepEqual((await db.query("SELECT * FROM stock_balances ORDER BY company_id,item_id,quantity_smallest")).rows, balances);
    // PGlite/pg share query SQL and values, but return rowCount under different names.
    const adapt = (source: Pick<PGlite, "query">) => ({ query: async (sql: string, params: unknown[] = []) => {
      const result = await source.query(sql, params);
      return {...result, rowCount: result.rows.length || result.affectedRows || 0};
    }}) as unknown as PoolClient;
    const client = adapt(db);
    const scan = (companyId: number) => db.transaction(tx => scanInventoryNotifications(adapt(tx),companyId));
    const inbox = async (companyId: number) => (await db.query<{event_key:string}>(`
      SELECT n.event_key FROM notifications n
      JOIN notification_templates t ON t.code=n.code
      LEFT JOIN notification_settings s ON s.company_id=n.company_id AND s.code=n.code
      WHERE ${inboxFilter} ORDER BY n.id`,[1,companyId,null,true])).rows.map(r=>r.event_key);
    const all = async () => (await db.query<{event_key:string}>("SELECT event_key FROM notifications ORDER BY id")).rows.map(r=>r.event_key);
    assert.equal((await effectiveTemplate(client,2,"INVENTORY_NEGATIVE"))?.enabled,true);
    assert.equal((await effectiveTemplate(client,2,"INVENTORY_NEGATIVE"))?.notifyOwner,true);
    await scan(2);
    await scan(2);
    await refreshNotificationReminders(client,2);
    assert.equal((await all()).length,1);
    assert.deepEqual(await inbox(2),[]);
    assert.equal((await db.query<{reminder_count:number}>("SELECT reminder_count FROM notifications")).rows[0].reminder_count,0);
    await scan(3);
    assert.deepEqual(await inbox(3),["INVENTORY_NEGATIVE:item:10:location:1:episode:1"]);
    await db.exec("UPDATE stock_balances SET quantity_smallest=-1 WHERE company_id=2 AND item_id=20");
    await scan(2);
    await scan(2);
    const fresh = "INVENTORY_NEGATIVE:reactivated:item:20:location:1:episode:";
    assert.deepEqual(await inbox(2),[fresh+"1"]); // Hidden history does not trip the configured delivery window.
    assert.equal((await all()).length,3);
    await db.exec("UPDATE notification_settings SET min_interval_hours=NULL WHERE company_id=2");
    await db.exec("UPDATE stock_balances SET quantity_smallest=0 WHERE company_id=2 AND item_id IN (10,20)");
    await scan(2);
    const resolved = await db.query<{reason:string}>("SELECT reason FROM notification_auto_resolutions ORDER BY notification_id");
    assert.deepEqual(resolved.rows.map(r=>r.reason),["negative_balance_recovered","negative_balance_recovered"]);
    await db.exec("UPDATE stock_balances SET quantity_smallest=-1 WHERE company_id=2 AND item_id IN (10,20)");
    await scan(2);
    const visible = await inbox(2);
    assert.equal(visible.length,3);
    assert.ok(visible.includes("INVENTORY_NEGATIVE:reactivated:item:10:location:1:episode:4"));
    assert.ok(visible.includes(fresh+"2"));
    await db.exec("UPDATE notification_settings SET enabled=false WHERE company_id=2");
    await db.exec("UPDATE stock_balances SET quantity_smallest=-5 WHERE company_id=2 AND item_id=30 AND quantity_smallest=5");
    await scan(2);
    assert.equal((await all()).length,5);
  } finally {
    await db.close();
  }
});
