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
