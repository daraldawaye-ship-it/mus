import {Router} from "express";
import type {Pool,PoolClient} from "pg";
import type {Request} from "express";
import {memoFeatureRuleSchema,memoFeatureRuleUpdateSchema} from "../../../packages/contracts/src/index.ts";
import {actor,handler,id,parse} from "./http.ts";
import {transaction} from "./db.ts";
import {currentActor,companyAccess} from "./policies/access.ts";
import {directoryEntries,assertDirectoryAccess,assertRequestPagesEnabled} from "./services/pages.ts";
import {featureRuleDTO,previewMemoFeatureEmployee,validateFeatureRuleTargets} from "./services/memo-feature-rules.ts";
import {audit} from "./services/audit.ts";
import {deny,HttpError,missing} from "./errors.ts";

export function memoFeatureRuleRoutes(pool:Pool){
 const router=Router(),base="/companies/:companyId/memo-feature-rules";
 async function guard(client:PoolClient,req:Request,write=false){
  const companyId=id(req.params.companyId),user=await currentActor(client,actor(req),write);
  const context=await companyAccess(client,user,companyId,undefined,write);
  if(!context.general)deny("إدارة قواعد الميزات للمالك أو المدير العام");
  if(write)await assertRequestPagesEnabled(client,req,true);
  const directory=await directoryEntries(client,user,companyId);
  assertDirectoryAccess(directory.find(e=>e.key==="company.memo-feature-rules")!,write?"edit":"view");
  return {companyId,user};
 }
 router.get(base,handler(async(req,res)=>{
  const result=await transaction(pool,async client=>{
   const current=await guard(client,req);
   const rules=(await client.query(
    "SELECT * FROM memo_feature_rules WHERE company_id=$1 ORDER BY id DESC",
    [current.companyId])).rows.map(featureRuleDTO);
   return {rules};
  });
  res.json(result);
 }));
 router.get(base+"/:ruleId/preview",handler(async(req,res)=>{
  const result=await transaction(pool,async client=>{
   const current=await guard(client,req);
   const row=(await client.query("SELECT * FROM memo_feature_rules WHERE company_id=$1 AND id=$2",
    [current.companyId,id(req.params.ruleId)])).rows[0];
   if(!row)missing();
   const rule=featureRuleDTO(row);
   const employees=(await client.query("SELECT id,name,role FROM employees WHERE company_id=$1 AND active ORDER BY id",
    [current.companyId])).rows;
   const impacted=[];
   for(const employee of employees){
    const value=await previewMemoFeatureEmployee(client,rule,employee);
    if(value.matched)impacted.push(value);
   }
   return {ruleId:rule.id,actionCode:rule.actionCode,effect:rule.effect,
    impacted,totalImpacted:impacted.length};
  });
  res.json(result);
 }));
 router.post(base,handler(async(req,res)=>{
  const input=parse(memoFeatureRuleSchema,req.body);
  if(input.effect==="block")throw new HttpError(400,"block_not_ready","المنع غير متاح قبل اكتمال اختبار الربط");
  const result=await transaction(pool,async client=>{
   const current=await guard(client,req,true);
   if(!await validateFeatureRuleTargets(client,current.companyId,input.employeeIds,input.roleIds))
    throw new HttpError(400,"invalid_targets","اختر موظفين وأدوارًا تابعة للشركة");
   const row=(await client.query(
    `INSERT INTO memo_feature_rules(company_id,name,enabled,employee_ids,role_ids,action_code,effect,
     minimum_count,minimum_hours,match_mode,exclude_deferred_until_due,message,created_by,changed_by)
     VALUES($1,$2,$3,$4::integer[],$5::integer[],$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
    [current.companyId,input.name,input.enabled,input.employeeIds,input.roleIds,input.actionCode,
     input.effect,input.minimumCount,input.minimumHours,input.matchMode,input.excludeDeferredUntilDue,
     input.message,current.user.id])).rows[0];
   await client.query(
     "INSERT INTO memo_feature_rule_changes(company_id,rule_id,revision,actor_user_id,previous_value,next_value) VALUES($1,$2,1,$3,NULL,$4::jsonb)",
     [current.companyId,row.id,current.user.id,JSON.stringify(input)]);
   await audit(client,current.user,"memo.feature-rule","memo-feature-rule",row.id,null,input,current.companyId);
   return {rule:featureRuleDTO(row)};
  });
  res.status(201).json(result);
 }));
 router.put(base+"/:ruleId",handler(async(req,res)=>{
  const input=parse(memoFeatureRuleUpdateSchema,req.body);
  if(input.effect==="block")throw new HttpError(400,"block_not_ready","المنع غير متاح قبل اكتمال اختبار الربط");
  const result=await transaction(pool,async client=>{
   const current=await guard(client,req,true),ruleId=id(req.params.ruleId);
   const previous=(await client.query(
    "SELECT * FROM memo_feature_rules WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [current.companyId,ruleId])).rows[0];
   if(!previous)missing();
   if(previous.revision!==input.revision)throw new HttpError(409,"revision_conflict","تغيرت القاعدة؛ حدث البيانات");
   if(!await validateFeatureRuleTargets(client,current.companyId,input.employeeIds,input.roleIds))
    throw new HttpError(400,"invalid_targets","اختر موظفين وأدوارًا تابعة للشركة");
   const row=(await client.query(
    `UPDATE memo_feature_rules SET name=$3,enabled=$4,employee_ids=$5::integer[],
     role_ids=$6::integer[],action_code=$7,effect=$8,minimum_count=$9,minimum_hours=$10,
     match_mode=$11,exclude_deferred_until_due=$12,message=$13,revision=revision+1,
     changed_by=$14,changed_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING *`,
    [current.companyId,ruleId,input.name,input.enabled,input.employeeIds,input.roleIds,
     input.actionCode,input.effect,input.minimumCount,input.minimumHours,input.matchMode,
     input.excludeDeferredUntilDue,input.message,current.user.id])).rows[0];
   const after=featureRuleDTO(row);
   await client.query(
    "INSERT INTO memo_feature_rule_changes(company_id,rule_id,revision,actor_user_id,previous_value,next_value) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
    [current.companyId,ruleId,after.revision,current.user.id,JSON.stringify(featureRuleDTO(previous)),JSON.stringify(after)]);
   await audit(client,current.user,"memo.feature-rule","memo-feature-rule",ruleId,
    featureRuleDTO(previous),after,current.companyId);
   return {rule:after};
  });
  res.json(result);
 }));
 return router;
}
