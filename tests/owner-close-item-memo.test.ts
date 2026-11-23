import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {PGlite} from "@electric-sql/pglite";

test("owner can close assigned company-2 item memo without becoming a participant", async t => {
 const db = new PGlite();
 t.after(()=>db.close());
 await db.exec(`
   CREATE TABLE users(id int PRIMARY KEY,owner boolean NOT NULL,suspended boolean NOT NULL DEFAULT false,archived boolean NOT NULL DEFAULT false);
   INSERT INTO users VALUES (1,true,false,false),(2,false,false,false),(3,false,false,false),(4,true,true,false);
   CREATE TABLE memos(company_id int,id int,revision int DEFAULT 1,status text,sender_user_id int,
      current_user_id int,current_employee_id int,current_name text,current_assigned_at timestamptz DEFAULT clock_timestamp(),
      current_assignment_revision int DEFAULT 1,recipient_user_id int,
      completion_requested_by_user_id int,completion_requested_by_employee_id int,completion_requested_by_name text,
      completion_requested_at timestamptz,completed_at timestamptz,completed_by_user_id int,completed_by_name text,
      PRIMARY KEY(company_id,id));
   CREATE TABLE memo_actions(id int PRIMARY KEY,company_id int,memo_id int,result_revision int,actor_user_id int,request_payload jsonb);
   CREATE TABLE memo_events(company_id int,memo_id int,action_id int,actor_user_id int,actor_name text,created_at timestamptz,kind text,
      target_user_id int,target_employee_id int,target_name text,assignment_revision int,body text);
   CREATE TABLE memo_reads(company_id int,memo_id int,user_id int);
   CREATE TABLE memo_assignment_reads(company_id int,memo_id int,user_id int,assignment_revision int);
   CREATE TABLE memo_participants(company_id int,memo_id int,user_id int);
   CREATE TABLE memo_links(company_id int,memo_id int,item_id int);
   INSERT INTO memos(company_id,id,status,sender_user_id,current_user_id,current_employee_id,current_name,recipient_user_id)
    VALUES (2,1,'pending',2,3,3,'assigned',3),(2,2,'pending',2,3,3,'assigned',3),
           (3,3,'pending',2,3,3,'assigned',3),(2,4,'pending',2,NULL,NULL,'admin',NULL),
           (2,5,'pending',2,3,3,'assigned',3),(2,6,'awaiting_approval',2,2,2,'sender',3),
           (2,7,'pending',2,2,2,'sender',2),(2,8,'pending',2,3,3,'assigned',3),
           (2,9,'pending',2,3,3,'assigned',3);
   INSERT INTO memo_links VALUES (2,1,10),(2,2,10),(3,3,10),(2,4,10),(2,6,10),(2,7,10),(2,8,10),(2,9,10);
   INSERT INTO memo_participants VALUES (2,2,3),(2,6,2),(2,7,2),(2,9,2);
 `);
 await db.exec(readFileSync(new URL("../apps/api/migrations/20261123_zzz_owner_close_assigned_item_memos.sql",import.meta.url),"utf8"));
 await db.exec("ALTER TABLE memos ADD CONSTRAINT memos_completed_state_check CHECK (status <> 'completed' OR (completed_by_user_id=sender_user_id AND current_user_id=sender_user_id))");
 await db.exec(readFileSync(new URL("../apps/api/migrations/20261123_zzzz_owner_close_completed_shape.sql",import.meta.url),"utf8"));
 await db.exec(`CREATE CONSTRAINT TRIGGER event_integrity AFTER INSERT ON memo_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_memo_event_integrity();
  CREATE CONSTRAINT TRIGGER conversation_integrity AFTER UPDATE ON memos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_memo_conversation_integrity();`);
 const close=(id:number, company:number, actor:number, type="owner-complete", eventKind="completed")=>db.transaction(async q=>{
   const time="2026-11-23T17:00:00Z";
   await q.query("INSERT INTO memo_actions VALUES ($1,$2,$1,2,$3,$4)",[id,company,actor,JSON.stringify({action:type,body:"Reason"})]);
   await q.query("UPDATE memos SET revision=2,status='completed',completed_by_user_id=$3,completed_by_name='Actor',completed_at=$4 WHERE company_id=$2 AND id=$1",[id,company,actor,time]);
   await q.query("INSERT INTO memo_events(company_id,memo_id,action_id,actor_user_id,actor_name,created_at,kind,body) VALUES ($2,$1,$1,$3,'Actor',$4,$5,'Reason')",[id,company,actor,time,eventKind]);
 });
 await close(1,2,1);
 assert.deepEqual((await db.query("SELECT status,current_user_id,recipient_user_id,completed_by_user_id FROM memos WHERE company_id=2 AND id=1")).rows,[{status:"completed",current_user_id:3,recipient_user_id:3,completed_by_user_id:1}]);
 assert.equal((await db.query("SELECT 1 FROM memo_participants WHERE company_id=2 AND memo_id=1")).rows.length,0);
 for(const args of [[2,2,3],[3,3,1],[4,2,1],[5,2,1],[6,2,1],[8,2,4]] as const)
  await assert.rejects(close(args[0],args[1],args[2]),/administrative close action|memos_completed_state_check/);
 await assert.rejects(close(9,2,2,"complete"),/original sender/);
 await close(7,2,2,"complete");
 assert.deepEqual((await db.query("SELECT id FROM memos WHERE status='completed' ORDER BY id")).rows,[{id:1},{id:7}]);
});
