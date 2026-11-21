import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { PoolClient } from "pg";
import { classifyDevice } from "../apps/api/src/services/user-device-activity.ts";
import { isCompanyActivityDesktop, notifyCompanyExternalDesktop } from "../apps/api/src/services/company-device-alert.ts";
import { companyExternalDesktopActivityCode, emitNotification, refreshNotificationReminders } from "../apps/api/src/services/notifications.ts";

test("Desktop notification detection excludes mobile and unknown agents", () => {
  for (const ua of [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36",
    "Mozilla/5.0 (X11; CrOS x86_64 15393) AppleWebKit Chrome/130.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15",
  ]) assert.equal(isCompanyActivityDesktop(ua, classifyDevice(ua)), true);
  for (const ua of [
    "Mozilla/5.0 (Linux; Android 14) Chrome/131.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows Phone 10.0; Android 4.2.1) Mobile Chrome/131.0",
    "curl/8.5", "",
  ]) assert.equal(isCompanyActivityDesktop(ua, classifyDevice(ua)), false);
});

test("new external desktop alerts are company scoped, owner only, and atomically capped per installation", async () => {
  const db = await PGlite.create({extensions:{pg_trgm}});
  try {
    const directory=new URL("../apps/api/migrations/",import.meta.url);
    const paths=(await readdir(directory)).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    // A deployed legacy prerequisite was applied before its receipt migration.
    const transfers="20261107_administrative_custody_transfers.sql";
    const receipts="20261107_administrative_custody_receipts.sql";
    if(paths.indexOf(transfers)>paths.indexOf(receipts)){
      paths.splice(paths.indexOf(transfers),1);
      paths.splice(paths.indexOf(receipts),0,transfers);
    }
    const newMigration="20261121_zzz_company_device_activity_alerts.sql";
    for(const name of paths.filter(x=>x!==newMigration)) await db.exec(await readFile(new URL(name,directory),"utf8"));
    await db.exec(`
      INSERT INTO users(name,display_name,email,password_hash,kind,owner) VALUES
       ('Owner','Owner','o@example.test','test','admin',true),
       ('Staff','Staff','s@example.test','test','member',false),
       ('Manager','Manager','m@example.test','test','member',false);
      INSERT INTO companies(name,created_by) VALUES('A',1),('B',1);
      INSERT INTO employees(company_id,user_id,name,created_by,is_general_manager) VALUES(1,2,'Staff',1,false),(1,3,'Manager',1,true);
      INSERT INTO company_known_devices(company_id,identity_hash,category,device_kind,approved,first_user_id,last_user_id) VALUES
       (1,repeat('a',64),'unclassified','desktop_browser',false,2,2),
       (1,repeat('b',64),'pharmacy','desktop_browser',false,2,2),
       (1,repeat('c',64),'employee','mobile_browser',true,2,2),
       (2,repeat('a',64),'employee','desktop_browser',true,1,1),
       (1,repeat('d',64),'employee','desktop_browser',true,2,2);
    `);
    await db.exec(await readFile(new URL(newMigration,directory),"utf8"));
    const client={query:async (sql:string,p?:unknown[])=>{
      const r=await db.query(sql,p);return {...r,rowCount:r.rows.length||r.affectedRows||0};
    }} as unknown as PoolClient;
    const notify=(companyId:number,deviceId:string)=>notifyCompanyExternalDesktop(client,{
      companyId,deviceId,label:"",browser:"Chrome",os:"Windows",
    });
    const read=async()=>(await db.query<{id:number;company_id:number;recipient_user_id:number;completed:boolean;repeat_interval:string;next_reminder_at:Date|null;message:string}>(
      "SELECT id,company_id,recipient_user_id,(completed_at IS NOT NULL) AS completed,repeat_interval,next_reminder_at,message FROM notifications WHERE code=$1 ORDER BY id",
      [companyExternalDesktopActivityCode],
    )).rows;
    assert.equal((await read()).length,0,"migration must not backfill alerts");
    await db.exec(`INSERT INTO notification_settings(company_id,code,importance,enabled,can_snooze,notify_managers,notify_subject,employee_ids,
      allow_repeat,repeat_interval,min_interval_hours,latest_only,notify_owner,updated_by)
      VALUES(1,'COMPANY_EXTERNAL_DESKTOP_ACTIVITY','medium',true,true,true,true,ARRAY[1,2],true,'day',24,false,false,1)`);
    await notify(1,"2"); await notify(1,"3"); await notify(2,"1");
    assert.equal((await read()).length,0,"mobile, company and wrong tenant never notify");
    await Promise.all([notify(1,"1"),notify(1,"1")]);
    assert.equal((await read()).length,1);
    assert.match((await read())[0]!.message,/DEV-000001/);
    await db.exec("UPDATE company_known_devices SET last_user_id=3,last_owner_activity_alert_at=clock_timestamp()-interval '59 minutes' WHERE id=1");
    await notify(1,"1");
    assert.equal((await read()).length,1,"changing accounts on the same device cannot reset cadence");
    await db.exec("UPDATE company_known_devices SET last_owner_activity_alert_at=clock_timestamp()-interval '60 minutes' WHERE id=1");
    await refreshNotificationReminders(client,1);
    assert.equal((await read()).length,1,"an elapsed hour without new activity does not create another alert");
    await notify(1,"1"); await notify(1,"5"); await notify(2,"4");
    await emitNotification(client,{code:companyExternalDesktopActivityCode,companyId:1,
      recipientUserId:3,explicitSubjectOnly:true,eventKey:"staff-attempt",subjectKey:"staff-attempt",message:"not delivered"});
    const final=await read();
    assert.equal(final.length,4);
    assert.deepEqual(final.map(r=>r.company_id),[1,1,1,2]);
    assert.deepEqual(final.map(r=>r.recipient_user_id),[1,1,1,1]);
    assert.deepEqual(final.map(r=>r.completed),[true,false,false,false]);
    assert.ok(final.every(r=>r.repeat_interval==="none"&&r.next_reminder_at===null));
  } finally {await db.close();}
});
