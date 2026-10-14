import type {PoolClient} from "pg";
import {z} from "zod";
import type {MemoReportResult} from "../../../../packages/contracts/src/index.ts";
import {memoFollowerSql} from "./memo-followers.ts";
export const memoReportQuerySchema=z.object({
 page:z.coerce.number().int().min(1).max(100000).default(1),
 pageSize:z.coerce.number().int().min(1).max(100).default(20),
 employeeId:z.coerce.number().int().positive().optional(),
 employeeRole:z.enum(["current","sender","executor"]).default("current"),
 status:z.enum(["pending","awaiting_approval","completed"]).optional(),
 type:z.enum(["task","inquiry","review","approval"]).optional(),
 deferred:z.enum(["yes","no"]).optional(),
 minHours:z.coerce.number().min(0).max(100000).optional(),
 dateField:z.enum(["created","assigned","completed"]).default("created"),
 from:z.iso.date().optional(),
 to:z.iso.date().optional(),
 pageKey:z.string().max(100).optional(),
 itemId:z.coerce.number().int().positive().optional(),
 accountId:z.coerce.number().int().positive().optional(),
}).strict();
export type MemoReportQuery=z.output<typeof memoReportQuerySchema>;
type MemoReportActor={companyId:number;userId:number;employeeId:number|null;general:boolean};
const number=(v:unknown)=>Number(v??0);
const iso=(v:Date|null|undefined)=>v?.toISOString()??null;
export async function memoReport(client:PoolClient,actor:MemoReportActor,filters:MemoReportQuery):Promise<MemoReportResult>{
 const params:unknown[]=[actor.companyId,actor.userId,actor.employeeId];
 const where:string[]=["m.company_id=$1"];
 if(!actor.general)where.push(`(m.sender_user_id=$2 OR
   (m.current_user_id=$2 AND (m.current_employee_id IS NULL OR m.current_employee_id=$3))
   OR EXISTS(SELECT 1 FROM memo_participants p WHERE p.company_id=m.company_id AND p.memo_id=m.id
     AND p.user_id=$2 AND (p.employee_id IS NULL OR p.employee_id=$3))
   OR ${memoFollowerSql("m","$3")})`);
 function match(column:string,value:unknown){params.push(value);where.push(`${column}=$${params.length}`);}
 if(filters.status)match("m.status",filters.status);
 if(filters.type)match("m.type",filters.type);
 if(filters.deferred)where.push(filters.deferred==="yes"?"COALESCE(s.active,false)":"NOT COALESCE(s.active,false)");
 if(filters.minHours!==undefined){
   params.push(filters.minHours);
   where.push(`EXTRACT(EPOCH FROM (COALESCE(m.completed_at,clock_timestamp())-m.current_assigned_at))/3600 >= $${params.length}`);
 }
 const dateColumn={created:"m.created_at",assigned:"m.current_assigned_at",completed:"m.completed_at"}[filters.dateField];
 if(filters.from){params.push(filters.from);where.push(`${dateColumn}>=($${params.length}::date AT TIME ZONE 'Asia/Aden')`);}
 if(filters.to){params.push(filters.to);where.push(`${dateColumn}<(($${params.length}::date+1) AT TIME ZONE 'Asia/Aden')`);}
 if(filters.employeeId!==undefined){
  params.push(filters.employeeId);
  const key="$"+params.length;
  if(filters.employeeRole==="current")where.push(`m.current_employee_id=${key}`);
  else if(filters.employeeRole==="sender")where.push(`EXISTS(SELECT 1 FROM employees e WHERE e.company_id=m.company_id AND e.user_id=m.sender_user_id AND e.id=${key})`);
  else where.push(`(m.recipient_employee_id=${key} OR EXISTS(
    SELECT 1 FROM memo_events ev WHERE ev.company_id=m.company_id AND ev.memo_id=m.id
    AND ev.kind IN ('forwarded','returned','reopened') AND ev.target_employee_id=${key}))`);
 }
 if(filters.pageKey){params.push(filters.pageKey);
  where.push(`EXISTS(SELECT 1 FROM memo_links l WHERE l.company_id=m.company_id AND l.memo_id=m.id
   AND (l.follow_page_key=$${params.length} OR l.reference_page_key=$${params.length}))`);}
 if(filters.itemId!==undefined){params.push(filters.itemId);
  where.push(`EXISTS(SELECT 1 FROM memo_links l WHERE l.company_id=m.company_id AND l.memo_id=m.id AND l.item_id=$${params.length})`);}
 if(filters.accountId!==undefined){params.push(filters.accountId);
  where.push(`EXISTS(SELECT 1 FROM memo_links l WHERE l.company_id=m.company_id AND l.memo_id=m.id AND l.account_id=$${params.length})`);}
 const scoped=`WITH visible AS MATERIALIZED(
  SELECT m.*,s.active AS deferred,s.due_at
  FROM memos m LEFT JOIN memo_schedules s ON s.company_id=m.company_id AND s.memo_id=m.id
  WHERE ${where.join(" AND ")}
 )`;
 const result=(await client.query(scoped+`
 SELECT count(*)::integer AS total,
 count(*) FILTER(WHERE status='pending')::integer AS pending,
 count(*) FILTER(WHERE status='awaiting_approval')::integer AS approval,
 count(*) FILTER(WHERE status='completed')::integer AS completed,
 count(*) FILTER(WHERE deferred)::integer AS deferred_count,
 ROUND((AVG(EXTRACT(EPOCH FROM (completed_at-created_at))/3600)
 FILTER(WHERE completed_at IS NOT NULL))::numeric,2) AS average_hours FROM visible`,params)).rows[0];
 const offset=(filters.page-1)*filters.pageSize;
 const rows=(await client.query(scoped+`
 SELECT v.*,EXTRACT(EPOCH FROM (COALESCE(v.completed_at,clock_timestamp())-v.created_at))/3600 AS age_hours,
 EXTRACT(EPOCH FROM (COALESCE(v.completed_at,clock_timestamp())-v.current_assigned_at))/3600 AS assignment_hours,
 CASE WHEN v.completion_requested_at IS NOT NULL THEN
 EXTRACT(EPOCH FROM (COALESCE(v.completed_at,clock_timestamp())-v.completion_requested_at))/3600 ELSE 0 END AS approval_hours,
 (SELECT count(*) FROM memo_events e WHERE e.company_id=v.company_id AND e.memo_id=v.id AND e.kind='reopened')::integer AS returns
 FROM visible v ORDER BY v.created_at DESC,v.id DESC
 LIMIT $${params.length+1} OFFSET $${params.length+2}`,
 [...params,filters.pageSize,offset])).rows;
 const ids=rows.map(row=>row.id);
 const segments=ids.length?(await client.query(`
 WITH epochs AS(
  SELECT m.id memo_id,
    CASE WHEN e.kind='created' THEN m.recipient_user_id ELSE e.target_user_id END AS user_id,
    CASE WHEN e.kind='created' THEN m.recipient_name ELSE e.target_name END AS name,
    CASE WHEN e.kind='completion_requested' THEN 'approval' ELSE 'execution' END AS role,
    e.created_at AS started,
    LEAD(e.created_at) OVER(PARTITION BY m.id ORDER BY e.created_at,e.id) AS next_start,
    m.completed_at
  FROM memos m JOIN memo_events e ON e.company_id=m.company_id AND e.memo_id=m.id
  WHERE m.company_id=$1 AND m.id=ANY($2::integer[])
  AND e.kind IN ('created','forwarded','returned','completion_requested','reopened')
 ) SELECT memo_id,user_id,name,role,
 ROUND((SUM(GREATEST(0,EXTRACT(EPOCH FROM
   (LEAST(COALESCE(next_start,clock_timestamp()),COALESCE(completed_at,clock_timestamp()))-started)))/3600))::numeric,2) hours
 FROM epochs WHERE user_id IS NOT NULL
 GROUP BY memo_id,user_id,name,role ORDER BY memo_id,user_id,role`,
 [actor.companyId,ids])).rows:[];
 const items=rows.map(row=>{
  const periods=segments.filter(s=>s.memo_id===row.id).map(s=>({
    userId:s.user_id as number,name:String(s.name??""),role:s.role as "execution"|"approval",hours:number(s.hours)
  }));
  return {id:row.id,title:row.title,type:row.type,status:row.status,
   senderName:row.sender_name,senderUserId:row.sender_user_id,
   currentName:row.current_name,currentUserId:row.current_user_id,
   currentEmployeeId:row.current_employee_id,
   createdAt:iso(row.created_at)!,assignedAt:iso(row.current_assigned_at)!,
   completedAt:iso(row.completed_at),dueAt:iso(row.due_at),deferred:!!row.deferred,
   ageHours:number(row.age_hours),assignmentHours:number(row.assignment_hours),
   approvalHours:number(row.approval_hours),
   executionHours:periods.filter(p=>p.role==="execution").reduce((sum,p)=>sum+p.hours,0),
   assignmentPeriods:periods,returnCount:number(row.returns),
   approvedExecution:row.status==="completed" && row.completion_requested_by_user_id!=null,
  };
 });
