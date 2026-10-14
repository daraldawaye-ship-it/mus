import type {PoolClient} from "pg";
import type {MemoFeatureRule,MemoFeatureImpact} from "../../../../packages/contracts/src/index.ts";
import {directoryEntries} from "./pages.ts";
import {userDTO} from "../repositories/models.ts";
export function featureRuleDTO(row:any):MemoFeatureRule{
 return {id:row.id,companyId:row.company_id,name:row.name,enabled:row.enabled,
  employeeIds:row.employee_ids,roleIds:row.role_ids,actionCode:row.action_code,effect:row.effect,
  minimumCount:row.minimum_count,minimumHours:row.minimum_hours===null?null:Number(row.minimum_hours),
  matchMode:row.match_mode,excludeDeferredUntilDue:row.exclude_deferred_until_due,
  message:row.message,revision:row.revision,changedAt:row.changed_at.toISOString()};
}
export async function validateFeatureRuleTargets(client:PoolClient,companyId:number,
 employeeIds:number[],roleIds:number[]){
 if(new Set(employeeIds).size!==employeeIds.length||new Set(roleIds).size!==roleIds.length)
  return false;
 const employees=employeeIds.length?(await client.query(
  "SELECT id FROM employees WHERE company_id=$1 AND id=ANY($2::integer[]) AND active",
  [companyId,employeeIds])).rowCount:0;
 const roles=roleIds.length?(await client.query(
  "SELECT id FROM company_roles WHERE company_id=$1 AND id=ANY($2::integer[]) AND active",
  [companyId,roleIds])).rowCount:0;
 return employees===employeeIds.length && roles===roleIds.length;
}
export async function previewMemoFeatureEmployee(client:PoolClient,
 rule:MemoFeatureRule,employee:{id:number;name:string;role:string}):Promise<MemoFeatureImpact>{
 let eligible=!rule.employeeIds.length&&!rule.roleIds.length ||
   rule.employeeIds.includes(employee.id);
 if(!eligible && rule.roleIds.length){
  eligible=!!(await client.query(
    `SELECT 1 FROM company_roles r WHERE r.company_id=$1 AND r.id=ANY($2::integer[]) AND r.active
      AND (r.key=$3 OR EXISTS(SELECT 1 FROM employee_role_assignments a
        WHERE a.company_id=r.company_id AND a.role_id=r.id AND a.employee_id=$4 AND a.active)) LIMIT 1`,
    [rule.companyId,rule.roleIds,employee.role,employee.id]
  )).rowCount;
 }
 if(!eligible)return {employeeId:employee.id,employeeName:employee.name,pendingCount:0,
  eligibleCount:0,oldestHours:0,matched:false,memoIds:[]};
 const rows=(await client.query(`
  SELECT m.id,EXTRACT(EPOCH FROM (clock_timestamp()-m.current_assigned_at))/3600 AS hours
  FROM memos m LEFT JOIN memo_schedules s ON s.company_id=m.company_id AND s.memo_id=m.id
  WHERE m.company_id=$1 AND m.current_employee_id=$2 AND m.status='pending'
    AND (NOT $3::boolean OR NOT COALESCE(s.active,false) OR s.due_at<=clock_timestamp())
  ORDER BY m.current_assigned_at ASC LIMIT 100001`,
  [rule.companyId,employee.id,rule.excludeDeferredUntilDue],
 )).rows;
 const ageMatches=rows.filter(row=>rule.minimumHours===null||Number(row.hours)>=rule.minimumHours);
 const minCount=rule.minimumCount;
 const countPass=minCount!==null && rows.length>=minCount;
 const agePass=rule.minimumHours!==null && ageMatches.length>=1;
 const matched=rule.matchMode==="any"?
  countPass||agePass:
  (minCount===null?agePass:rule.minimumHours===null?countPass:ageMatches.length>=minCount);
 return {employeeId:employee.id,employeeName:employee.name,pendingCount:rows.length,
  eligibleCount:ageMatches.length,oldestHours:rows.length?Number(rows[0].hours):0,
  matched,memoIds:ageMatches.slice(0,20).map(row=>row.id)};
}

export interface MemoFeatureMatch {
 ruleId:number;ruleName:string;effect:"monitor"|"warn"|"block";message:string;
 count:number;oldestHours:number;memoIds:number[];
}
export async function matchingMemoFeatureRules(client:PoolClient,companyId:number,
 userId:number,actionCode:"invoice.sale.create"|"invoice.purchase.create"):Promise<MemoFeatureMatch[]>{
 const staff=(await client.query(
  "SELECT id,name,role FROM employees WHERE company_id=$1 AND user_id=$2 AND active",
  [companyId,userId])).rows[0];
 if(!staff)return [];
 const userRow=(await client.query("SELECT * FROM users WHERE id=$1 AND NOT archived AND NOT suspended",[userId])).rows[0];
 if(!userRow)return [];
 const pages=await directoryEntries(client,userDTO(userRow),companyId);
 if(!["company.memos","company.memo-detail"].every(key=>
     pages.find(page=>page.key===key)?.actionAccess.view))return [];
 const rules=(await client.query(
  "SELECT * FROM memo_feature_rules WHERE company_id=$1 AND action_code=$2 AND enabled ORDER BY id",
  [companyId,actionCode])).rows;
 const matches:MemoFeatureMatch[]=[];
 for(const row of rules){
  const rule=featureRuleDTO(row);
  const impact=await previewMemoFeatureEmployee(client,rule,staff);
  if(!impact.matched)continue;
  matches.push({ruleId:rule.id,ruleName:rule.name,effect:rule.effect,
   message:rule.message||"راجع المذكرات المعلقة ضمن «مطلوب مني».",
   count:impact.pendingCount,oldestHours:impact.oldestHours,memoIds:impact.memoIds});
 }
 return matches;
}
