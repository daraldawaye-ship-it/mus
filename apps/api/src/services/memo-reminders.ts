import type {PoolClient} from "pg";
import type {MemoSchedule,User} from "../../../../packages/contracts/src/index.ts";
import {audit} from "./audit.ts";
import {userDTO} from "../repositories/models.ts";
import {directoryEntries} from "./pages.ts";
import {emitNotification,effectiveTemplate} from "./notifications.ts";
export const scheduleSelect=`SELECT s.*,s.local_day::text AS local_date, to_char(s.local_time,'HH24:MI') AS local_clock FROM memo_schedules s`;
export function scheduleDTO(row:any):MemoSchedule {
 return {revision:row.revision,active:row.active,dueAt:row.due_at.toISOString(),
  localDate:row.local_date,localTime:row.local_clock,repeatInterval:row.repeat_interval,
  reason:row.reason,actorName:row.actor_name,lastTriggeredAt:row.last_triggered_at?.toISOString()??null};
}
export async function scheduleDetails(client:PoolClient,companyId:number,memoId:number) {
 const [schedule,history]=await Promise.all([
  client.query(scheduleSelect+" WHERE s.company_id=$1 AND s.memo_id=$2",[companyId,memoId]),
  client.query("SELECT id,revision,kind,actor_name,reason,due_at,created_at FROM memo_schedule_history WHERE company_id=$1 AND memo_id=$2 ORDER BY id",
   [companyId,memoId]),
 ]);
 return {schedule:schedule.rows[0]?scheduleDTO(schedule.rows[0]):null,
  scheduleRevision:schedule.rows[0]?.revision??0,
  scheduleHistory:history.rows.map(r=>({id:r.id,revision:r.revision,kind:r.kind,
   actorName:r.actor_name,reason:r.reason,dueAt:r.due_at?.toISOString()??null,
   createdAt:r.created_at.toISOString()}))};
}
export async function addScheduleHistory(client:PoolClient,
 companyId:number,memoId:number,revision:number,kind:string,reason:string,
 actor:User|null,dueAt:Date|null,details:unknown={}) {
 await client.query(
  "INSERT INTO memo_schedule_history(company_id,memo_id,revision,kind,actor_user_id,actor_name,reason,due_at,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
  [companyId,memoId,revision,kind,actor?.id??null,actor?.displayName??null,reason,dueAt,JSON.stringify(details)]);
}
