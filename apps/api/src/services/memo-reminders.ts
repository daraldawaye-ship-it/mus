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
export async function closeScheduleNotice(client:PoolClient,companyId:number,memoId:number,actor:User|null,reason:string) {
 const rows=(await client.query(
  `UPDATE notifications SET completed_at=clock_timestamp(),
    read_at=COALESCE(read_at,clock_timestamp()),snoozed_until=NULL,next_reminder_at=NULL,
    revision=revision+1,updated_at=clock_timestamp()
   WHERE company_id=$1 AND code='MEMO_DUE' AND subject_key=$2 AND completed_at IS NULL
   RETURNING id`,[companyId,`memo:${memoId}`],
 )).rows;
 for(const row of rows)
  await audit(client,actor,"notification.follow","notification",row.id,{completedAt:null},
   {action:"supersede",reason},companyId);
}
export async function cancelScheduleForTransition(client:PoolClient,companyId:number,
 memoId:number,actor:User,reason:string) {
 const previous=(await client.query(
  "SELECT * FROM memo_schedules WHERE company_id=$1 AND memo_id=$2 FOR UPDATE",
  [companyId,memoId],
 )).rows[0];
 if(previous?.active){
  await client.query(
   "UPDATE memo_schedules SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND memo_id=$2",
   [companyId,memoId]);
  await addScheduleHistory(client,companyId,memoId,previous.revision+1,"transition",
   reason,actor,previous.due_at,{priorAssignment:previous.assignment_revision});
 }
 await closeScheduleNotice(client,companyId,memoId,actor,reason);
}
export async function scanDueMemoSchedules(client:PoolClient,companyId:number) {
 const rows=(await client.query(`
  SELECT s.*,m.status,m.current_user_id,m.current_employee_id,
   m.current_assignment_revision,m.title
  FROM memo_schedules s JOIN memos m ON m.company_id=s.company_id AND m.id=s.memo_id
  WHERE s.company_id=$1 AND s.active AND s.due_at<=clock_timestamp()
  ORDER BY s.due_at,s.memo_id LIMIT 50 FOR UPDATE OF s SKIP LOCKED`,
  [companyId],
 )).rows;
 for(const row of rows){
  const current=row.status!=="completed" &&
   row.assignee_user_id===row.current_user_id &&
   row.assignment_revision===row.current_assignment_revision;
  if(!current) {
    await client.query(
      "UPDATE memo_schedules SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND memo_id=$2",
      [companyId,row.memo_id]);
    await addScheduleHistory(client,companyId,row.memo_id,row.revision+1,
      "transition","تغير المسؤول أو أُنجزت المذكرة",null,row.due_at);
    await closeScheduleNotice(client,companyId,row.memo_id,null,"assignment-changed");
    continue;
  }
  await client.query(
   "UPDATE memo_schedules SET active=false,revision=revision+1,last_triggered_at=clock_timestamp(),updated_at=clock_timestamp() WHERE company_id=$1 AND memo_id=$2",
   [companyId,row.memo_id]);
  await addScheduleHistory(client,companyId,row.memo_id,row.revision+1,
   "due","حلّ موعد العودة للمتابعة",null,row.due_at);
  const userRow=(await client.query(
   "SELECT * FROM users WHERE id=$1 AND NOT archived AND NOT suspended",[row.assignee_user_id],
  )).rows[0];
  if(!userRow)continue;
  if(row.current_employee_id!==null && !(await client.query(
   "SELECT 1 FROM employees WHERE company_id=$1 AND id=$2 AND user_id=$3 AND active",
   [companyId,row.current_employee_id,row.assignee_user_id],
  )).rowCount)continue;
  const user=userDTO(userRow);
  try{
   const pages=await directoryEntries(client,user,companyId);
   if(!["company.memos","company.memo-detail","company.notifications"]
     .every(k=>pages.find(e=>e.key===k)?.actionAccess.view))continue;
  }catch{continue;}
  const template=await effectiveTemplate(client,companyId,"MEMO_DUE");
  if(!template?.enabled)continue;
  await closeScheduleNotice(client,companyId,row.memo_id,null,"new-due-reminder");
  await emitNotification(client,{
   code:"MEMO_DUE",companyId,recipientUserId:row.assignee_user_id,
   subjectEmployeeId:row.current_employee_id,explicitSubjectOnly:true,
   subjectKey:`memo:${row.memo_id}`,
   eventKey:`memo:${row.memo_id}:due:${row.revision+1}`,
   title:`موعد متابعة: ${row.title}`,
   message:`حلّ موعد متابعة المذكرة: ${row.title}`,
   href:`/companies/${companyId}/memos/${row.memo_id}`,
  });
  await client.query(
   "UPDATE notifications SET repeat_interval='none',next_reminder_at=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND code='MEMO_DUE' AND event_key=$2 AND completed_at IS NULL AND (repeat_interval<>'none' OR next_reminder_at IS NOT NULL)",
   [companyId,`memo:${row.memo_id}:due:${row.revision+1}`]);
 }
}
