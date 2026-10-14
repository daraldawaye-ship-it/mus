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
