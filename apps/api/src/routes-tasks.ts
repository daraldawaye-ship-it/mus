import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { currentActor, companyAccess } from "./policies/access.ts";
import { HttpError, deny } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { directoryEntries, assertDirectoryAccess, assertRequestPagesEnabled } from "./services/pages.ts";
import type { User } from "../../../packages/contracts/src/index.ts";

const kinds = ["memo_required","composition_review","stock_count"] as const;
type Kind = (typeof kinds)[number];
const defaults: Record<Kind,{name:string;description:string;target:number;href:string;source:string}> = {
 memo_required: {name:"إنجاز المذكرات",description:"المذكرات المسندة إليك ولم يُعتمد إنجازها",target:1,href:"memos?box=required",source:"company.memos"},
 composition_review: {name:"مراجعة اختلاف التركيب",description:"تعديلات كرت الصنف أو كرت التركيب المسجلة باسمك خلال فترة التقييم",target:3,href:"item-compositions",source:"company.item-compositions"},
 stock_count: {name:"تسويات الأصناف",description:"تسوية الأصناف المستحقة للجرد وفق حركة المبيعات وآخر جرد للمعرض",target:10,href:"stock-adjustments?taskSource=required-count",source:"company.stock-adjustments"},
};
const change = z.object({
 revision:z.number().int().min(0),
 enabled:z.boolean(),
 targetCount:z.number().int().min(1).max(1000),
 periodDays:z.number().int().min(1).max(365),
 assignedEmployeeIds:z.array(z.number().int().positive()).max(500),
 followerEmployeeIds:z.array(z.number().int().positive()).max(500),
}).strict();
const keyOf=(v:string|undefined):Kind=>{
 if(!kinds.includes(v as Kind)) throw new HttpError(404,"not_found","تعريف المهمة غير موجود");
 return v as Kind;
};
const dueStockQuery=`
 WITH sold AS (
   SELECT item_id,sum(sale_invoices) AS times FROM item_daily_activity
   WHERE company_id=$1 AND document_date>=(clock_timestamp() AT TIME ZONE 'Asia/Aden')::date-29
   GROUP BY item_id
 )
 SELECT i.id,i.code,i.name,coalesce(sold.times,0)::integer AS sales,
   ceil(240.0/(coalesce(sold.times,0)+5))::integer AS interval_days
 FROM items i JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id
 LEFT JOIN sold ON sold.item_id=i.id
 WHERE i.company_id=$1 AND i.active AND s.stock_showroom<>0
   AND (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date -
       COALESCE((s.last_showroom_adjustment_at AT TIME ZONE 'Asia/Aden')::date,
                (i.created_at AT TIME ZONE 'Asia/Aden')::date)
       >= ceil(240.0/(coalesce(sold.times,0)+5))
 ORDER BY interval_days,i.name,i.id
 `;
export async function isItemDueForCount(client:PoolClient,companyId:number,itemId:number):Promise<boolean> {
 return !!(await client.query("SELECT 1 FROM ("+dueStockQuery+") d WHERE d.id=$2 LIMIT 1",[companyId,itemId])).rowCount;
}
type Settings={enabled:boolean;targetCount:number;periodDays:number;assignedEmployeeIds:number[];followerEmployeeIds:number[];revision:number};
function settingsOf(kind:Kind,row?:Record<string,any>):Settings {
 return {enabled:row?.enabled??true,targetCount:row?.target_count??defaults[kind].target,
 periodDays:row?.period_days??1,assignedEmployeeIds:row?.assigned_employee_ids??[],
 followerEmployeeIds:row?.follower_employee_ids??[],revision:row?.revision??0};
}
async function companyTasks(client:PoolClient,user:User,companyId:number,withAll=false) {
 const context=await companyAccess(client,user,companyId);
 const pages=await directoryEntries(client,user,companyId);
 assertDirectoryAccess(pages.find(p=>p.key==="company.tasks")!);
 const settings=(await client.query("SELECT * FROM automatic_task_settings WHERE company_id=$1",[companyId])).rows;
 const results=[];
 for(const kind of kinds) {
  const config=settingsOf(kind,settings.find(r=>r.task_key===kind));
  const permitted=!!pages.find(p=>p.key===defaults[kind].source)?.actionAccess.view;
  const assigned=context.general || (!config.assignedEmployeeIds.length ||
    (context.employee!==null&&config.assignedEmployeeIds.includes(context.employee.id)));
  const follows=context.general || (context.employee!==null&&config.followerEmployeeIds.includes(context.employee.id));
  if(!assigned&&!follows) continue;
  // A task does not bypass authorization on its underlying records or actions.
  if(!permitted) continue;
  let completed=0,required=0,available=0;
  if(kind==="memo_required") {
   const row=(await client.query(`SELECT count(*)::integer AS total FROM memos
     WHERE company_id=$1 AND current_user_id=$2 AND status='pending'
       AND (current_employee_id IS NULL OR current_employee_id=$3::integer)`,
       [companyId,user.id,context.employee?.id??null])).rows[0];
   required=Number(row.total);available=required;
  }else if(kind==="composition_review") {
   const availableRow=(await client.query(
     "SELECT EXISTS(SELECT 1 FROM items WHERE company_id=$1 AND active) OR EXISTS(SELECT 1 FROM item_compositions WHERE company_id=$1 AND active) AS found",
     [companyId])).rows[0];
   available=availableRow.found?1:0;
   completed=Number((await client.query(`SELECT count(*)::integer AS total FROM audit_events
      WHERE company_id=$1 AND actor_id=$2 AND action IN ('item.update','itemComposition.update')
      AND created_at>=clock_timestamp()-($3::integer*interval '1 day')`,
      [companyId,user.id,config.periodDays])).rows[0].total);
   required=Math.max(config.targetCount-completed,0);
  }else{
   available=Number((await client.query("SELECT count(*)::integer AS total FROM ("+dueStockQuery+") d",[companyId])).rows[0].total);
   completed=Number((await client.query(`SELECT count(*)::integer AS total FROM automatic_task_count_events
     WHERE company_id=$1 AND actor_user_id=$2
       AND created_at>=clock_timestamp()-($3::integer*interval '1 day')`,
     [companyId,user.id,config.periodDays])).rows[0].total);
   required=Math.max(config.targetCount-completed,0);
  }
  const visible=config.enabled&&(kind==="memo_required"?required>0:available>0&&required>0);
  if(!withAll&&!visible)continue;
  results.push({key:kind,name:defaults[kind].name,description:defaults[kind].description,
   href:`/companies/${companyId}/${defaults[kind].href}`,
   companyId,enabled:config.enabled,completed,required,available,
   visible,targetCount:config.targetCount,periodDays:config.periodDays,
   assignedEmployeeIds:config.assignedEmployeeIds,followerEmployeeIds:config.followerEmployeeIds,
   revision:config.revision,canControl:context.general,canFollow:follows,canExecute:assigned});
 }
 return results;
}
export function taskRoutes(pool:Pool):Router {
 const router=Router();
 router.get("/tasks",handler(async(req,res)=>{
  const items=await transaction(pool,async client=>{
   await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
   const user=await currentActor(client,actor(req),false);
   const directory=await directoryEntries(client,user,null);
   assertDirectoryAccess(directory.find(p=>p.key==="public.tasks")!);
   const companies=(await client.query(`
    SELECT c.id,c.name FROM companies c WHERE $1::boolean OR EXISTS(
      SELECT 1 FROM employees e WHERE e.company_id=c.id AND e.user_id=$2 AND e.active
    ) ORDER BY c.id LIMIT 100`,[user.owner,user.id])).rows;
   const output=[];
   for(const company of companies){
    const tasks=await companyTasks(client,user,company.id,false);
    output.push(...tasks.map(task=>({...task,companyName:company.name})));
   }
   return output;
  });
  res.json({items});
 }));
 router.get("/companies/:companyId/tasks",handler(async(req,res)=>{
  const all=req.query.all==="true";
  const items=await transaction(pool,async client=>{
   await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
   return companyTasks(client,await currentActor(client,actor(req),false),id(req.params.companyId),all);
  });
  res.json({items});
 }));
 router.get("/companies/:companyId/tasks/stock_count/items",handler(async(req,res)=>{
  const items=await transaction(pool,async client=>{
   await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
   const user=await currentActor(client,actor(req),false),companyId=id(req.params.companyId);
   const accessible=await companyTasks(client,user,companyId,true);
   if(!accessible.some(t=>t.key==="stock_count"&&t.canExecute))deny();
   return (await client.query(dueStockQuery+" LIMIT 50",[companyId])).rows.map(row=>({
     id:row.id,code:row.code,name:row.name,sales:row.sales,intervalDays:row.interval_days,
   }));
  });
  res.json({items});
 }));
 router.put("/companies/:companyId/tasks/:taskKey",handler(async(req,res)=>{
  const taskKey=keyOf(req.params.taskKey),input=parse(change,req.body);
  const result=await transaction(pool,async client=>{
   const user=await currentActor(client,actor(req),true),companyId=id(req.params.companyId);
   const context=await companyAccess(client,user,companyId,undefined,true);
   if(!context.general)deny("كنترول المهمة للمالك أو المدير العام فقط");
   await assertRequestPagesEnabled(client,req,true);
   const pages=await directoryEntries(client,user,companyId);
   assertDirectoryAccess(pages.find(p=>p.key==="company.tasks")!,"edit");
   const previous=(await client.query(
      "SELECT * FROM automatic_task_settings WHERE company_id=$1 AND task_key=$2 FOR UPDATE",
      [companyId,taskKey])).rows[0];
   const before=settingsOf(taskKey,previous);
   if(before.revision!==input.revision)
    throw new HttpError(409,"conflict","عُدلت إعدادات المهمة من مستخدم آخر، أعد تحميلها");
   const assigned=[...new Set(input.assignedEmployeeIds)],followers=[...new Set(input.followerEmployeeIds)];
   const all=[...new Set([...assigned,...followers])];
   if(all.length){
    const members=(await client.query(`SELECT id FROM employees WHERE company_id=$1 AND active AND id=ANY($2::integer[])`,[companyId,all])).rows;
    if(members.length!==all.length)
     throw new HttpError(400,"invalid_employee","حدد موظفين نشطين من نفس الشركة");
   }
   const updated=(await client.query(`
    INSERT INTO automatic_task_settings
    (company_id,task_key,enabled,target_count,period_days,assigned_employee_ids,follower_employee_ids,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(company_id,task_key) DO UPDATE SET
       enabled=EXCLUDED.enabled,target_count=EXCLUDED.target_count,
       period_days=EXCLUDED.period_days,assigned_employee_ids=EXCLUDED.assigned_employee_ids,
       follower_employee_ids=EXCLUDED.follower_employee_ids,
       updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp(),
       revision=automatic_task_settings.revision+1
    RETURNING *`,
    [companyId,taskKey,input.enabled,input.targetCount,input.periodDays,assigned,followers,user.id])).rows[0];
   const after=settingsOf(taskKey,updated);
   await audit(client,user,"automaticTask.settings","automaticTask",companyId,before,after,companyId);
   return after;
  });
  res.json({settings:result});
 }));
 return router;
}
