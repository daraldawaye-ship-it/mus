import type {PoolClient} from "pg";
import type {MemoSchedule,User} from "../../../../packages/contracts/src/index.ts";
import {audit} from "./audit.ts";
import {userDTO} from "../repositories/models.ts";
import {directoryEntries} from "./pages.ts";
import {emitNotification,effectiveTemplate} from "./notifications.ts";
import {notifyDueMemoSender} from "./memo-sender-alert.ts";
export const scheduleSelect=`SELECT s.*,s.local_day::text AS local_date, to_char(s.local_time,'HH24:MI') AS local_clock FROM memo_schedules s`;
export function scheduleDTO(row:any):MemoSchedule {
 return {revision:row.revision,active:row.active,returned:Boolean(row.returned),reminderCount:row.cycle_index??0,dueAt:row.due_at.toISOString(),
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
   WHERE company_id=$1 AND code IN ('MEMO_DUE','MEMO_DELAYED') AND subject_key=$2 AND completed_at IS NULL
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
/** Preserve the original local day of month (e.g. 31) across short months. */
export function nextRecurringMemoDue(anchor:string,time:string,interval:"day"|"week"|"month",
 now:Date,minimumCycle:number):{date:Date;cycle:number}{
 const [y,m,d]=anchor.split("-").map(Number);
 const [hour,minute]=time.split(":").map(Number);
 const utcAnchor=Date.UTC(y!,m!-1,d!);
 const adenNow=new Date(now.getTime()+3*3600000);
 const nowLocalDate=Date.UTC(adenNow.getUTCFullYear(),adenNow.getUTCMonth(),adenNow.getUTCDate());
 let cycle=minimumCycle;
 if(interval==="day")cycle=Math.max(cycle,Math.floor((nowLocalDate-utcAnchor)/86400000));
 else if(interval==="week")cycle=Math.max(cycle,Math.floor((nowLocalDate-utcAnchor)/(7*86400000)));
 else cycle=Math.max(cycle,12*(adenNow.getUTCFullYear()-y!)
     +adenNow.getUTCMonth()-(m!-1));
 function at(index:number):Date {
   if(interval==="month"){
     const monthStart=new Date(Date.UTC(y!,m!-1+index,1));
     const yy=monthStart.getUTCFullYear(),mm=monthStart.getUTCMonth();
     const last=new Date(Date.UTC(yy,mm+1,0)).getUTCDate();
     return new Date(Date.UTC(yy,mm,Math.min(d!,last),hour!,minute!)-3*3600000);
   }
   const extraDays=index*(interval==="week"?7:1);
   return new Date(utcAnchor+extraDays*86400000+(hour!*60+minute!)*60000-3*3600000);
 }
 let next=at(cycle);
 if(next.getTime()<=now.getTime()){cycle++;next=at(cycle);}
 return {date:next,cycle};
}
export async function scanDueMemoSchedules(client:PoolClient,companyId:number) {
 const rows=(await client.query(`
  SELECT s.*,m.status,m.current_user_id,m.current_employee_id,
   m.current_assignment_revision,m.sender_user_id,m.title
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
  const template=await effectiveTemplate(client,companyId,"MEMO_DUE");
  const repeat=row.repeat_interval!=="none" && !!template?.allowRepeat && !!template?.enabled;
  const next=repeat?nextRecurringMemoDue(
   new Date(row.local_day).toISOString().slice(0,10),
   String(row.local_time).slice(0,5),row.repeat_interval,
   new Date(),row.cycle_index+1):null;
  await client.query(
   `UPDATE memo_schedules SET active=$3,returned=true,
     due_at=COALESCE($4::timestamptz,due_at),cycle_index=$5,
     revision=revision+1,last_triggered_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE company_id=$1 AND memo_id=$2`,
   [companyId,row.memo_id,!!next,next?.date??null,next?.cycle??row.cycle_index]);
  await addScheduleHistory(client,companyId,row.memo_id,row.revision+1,
   row.returned?"repeated":"due","حلّ موعد التذكير",null,row.due_at,
   {nextAt:next?.date?.toISOString()??null,skippedToCycle:next?.cycle??null});
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
  if(!template?.enabled)continue;
  const previousNotice=(await client.query(
    "SELECT id,reminder_count FROM notifications WHERE company_id=$1 AND code='MEMO_DUE' AND subject_key=$2 AND recipient_user_id=$3 AND completed_at IS NULL FOR UPDATE",
    [companyId,`memo:${row.memo_id}`,row.assignee_user_id],
  )).rows[0];
  if(previousNotice){
    await client.query(
      "UPDATE notifications SET read_at=NULL,reminder_count=reminder_count+1,last_reminded_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1",
      [previousNotice.id]);
    await audit(client,null,"notification.remind","notification",previousNotice.id,
      {reminderCount:previousNotice.reminder_count},
      {reminderCount:previousNotice.reminder_count+1,reason:"memo-repeat"},companyId);
  }else await emitNotification(client,{
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
  await notifyDueMemoSender(client,companyId,row.memo_id,row.title,
    row.sender_user_id,row.assignee_user_id,row.revision+1);
 }
}
