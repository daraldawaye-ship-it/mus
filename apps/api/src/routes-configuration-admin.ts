import { z } from "zod";
import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import {
  optionValueTypes,
  type OptionDefinition,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { currentActor, companyAccess } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";

const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/);
const choice = z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/), label: z.string().trim().min(1).max(120) }).strict();
const optionInput = z.object({
  key, pageKey: z.string().min(1).max(100), recordKind: z.enum(["item","account","employee","invoice","financial-document"]),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(""),
  valueType: z.enum(optionValueTypes),
  defaultValue: z.union([z.boolean(),z.string(),z.null()]).default(null),
  choices: z.array(choice).max(100).default([]),
  required: z.boolean().default(false),
  searchable: z.boolean().default(false),
  showOnCard: z.boolean().default(true),
  showInList: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  active: z.boolean().default(true),
}).strict();
const optionChange = optionInput.omit({key:true,pageKey:true,recordKind:true})
  .extend({ revision: z.number().int().positive() });
const roleInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).default(""),
}).strict();
const roleChange = roleInput.omit({key:true}).extend({
  active: z.boolean(), revision: z.number().int().positive(),
});
const ruleInput = z.object({
  roleId: z.number().int().positive(),
  permissionKey: z.string().min(1).max(140),
  effect: z.enum(["allow", "deny"]),
}).strict();
const ruleChange = z.object({
  effect: z.enum(["allow","deny"]),
  active: z.boolean(),
  revision: z.number().int().positive(),
}).strict();

const optionColumns = `id,key,page_key AS "pageKey",record_kind AS "recordKind",
 name,description,value_type AS "valueType",default_value AS "defaultValue",choices,
 required,searchable,show_on_card AS "showOnCard",show_in_list AS "showInList",
 sort_order AS "sortOrder",active,is_system AS "system",
 native_binding AS "nativeBinding",revision`;
const roleColumns = `id,key,name,description,active,is_system AS "system",revision`;
const ruleColumns = `r.id,r.role_id AS "roleId",r.permission_key AS "permissionKey",
 p.name AS "permissionName",p.page_key AS "pageKey",p.action,r.effect,r.active,r.revision`;
async function authorized(client: PoolClient, req: Request, general = false) {
  const companyId = id(req.params.companyId);
  const user = await currentActor(client, actor(req));
  const context = await companyAccess(client, user, companyId, "pages.manage", true);
  if (general && !context.general)
    throw new HttpError(403,"forbidden","إدارة منح الصلاحيات للمالك أو المدير العام فقط");
  return {companyId,user};
}
async function optionsSnapshot(client: PoolClient, companyId: number, optionId: number) {
  const result = await client.query(`SELECT ${optionColumns} FROM option_definitions WHERE company_id=$1 AND id=$2`,[companyId,optionId]);
  if (!result.rows[0]) missing();
  return result.rows[0] as OptionDefinition;
}
async function currentRole(client:PoolClient, companyId:number, roleId:number) {
  const r=await client.query(`SELECT ${roleColumns} FROM company_roles WHERE company_id=$1 AND id=$2`,[companyId,roleId]);
  if (!r.rows[0]) missing();
  return r.rows[0];
}
async function currentRule(client:PoolClient,companyId:number,ruleId:number) {
  const r=await client.query(`SELECT ${ruleColumns} FROM role_permission_rules r
    JOIN permission_definitions p ON p.key=r.permission_key WHERE r.company_id=$1 AND r.id=$2`,[companyId,ruleId]);
  if (!r.rows[0]) missing();
  return r.rows[0];
}
const changed = () => new HttpError(409,"conflict","تغيرت البيانات بواسطة مستخدم آخر؛ أعد تحميلها");
export function configurationAdminRoutes(pool:Pool):Router {
  const router=Router();
  router.get("/companies/:companyId/configuration-directory", handler(async(req,res)=>{
    const out=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const {companyId}=await authorized(client,req);
      const [options,roles,permissions,rules,assignments,exceptions,targets]=await Promise.all([
        client.query(`SELECT ${optionColumns} FROM option_definitions WHERE company_id=$1 ORDER BY page_key,sort_order,id`,[companyId]),
        client.query(`SELECT ${roleColumns} FROM company_roles WHERE company_id=$1 ORDER BY name,id`,[companyId]),
        client.query(`SELECT key,page_key AS "pageKey",action,name,rule_role AS "ruleRole",
          required_permissions AS "requiredPermissions",active FROM permission_definitions ORDER BY page_key,action`),
        client.query(`SELECT ${ruleColumns} FROM role_permission_rules r
          JOIN permission_definitions p ON p.key=r.permission_key WHERE r.company_id=$1 ORDER BY r.role_id,p.page_key,p.action`,[companyId]),
        client.query(`SELECT a.id,a.employee_id AS "employeeId",a.role_id AS "roleId",a.active,a.revision,
          e.name AS "employeeName" FROM employee_role_assignments a
          JOIN employees e ON e.id=a.employee_id AND e.company_id=a.company_id
          WHERE a.company_id=$1 ORDER BY a.employee_id,a.role_id`,[companyId]),
        client.query(`SELECT r.id,r.employee_id AS "employeeId",r.permission_key AS "permissionKey",
          r.effect,r.active,r.revision FROM employee_permission_rules r WHERE r.company_id=$1`,[companyId]),
        client.query(`SELECT page_key AS "pageKey",record_kind AS "recordKind" FROM option_record_targets ORDER BY page_key`),
      ]);
      return {options:options.rows,roles:roles.rows,permissions:permissions.rows,rules:rules.rows,
        assignments:assignments.rows,exceptions:exceptions.rows,targets:targets.rows};
    });
    res.json(out);
  }));
  router.post("/companies/:companyId/configuration-options",handler(async(req,res)=>{
    const input=parse(optionInput,req.body);
    const value=await transaction(pool,async client=>{
      const {companyId,user}=await authorized(client,req);
      await assertRequestPagesEnabled(client,req,true);
      const inserted=await client.query(`INSERT INTO option_definitions(
        company_id,key,page_key,record_kind,name,description,value_type,default_value,choices,
        required,searchable,show_on_card,show_in_list,sort_order,active,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$16)
        RETURNING id`,[companyId,input.key,input.pageKey,input.recordKind,input.name,input.description,
        input.valueType,JSON.stringify(input.defaultValue),JSON.stringify(input.choices),input.required,
        input.searchable,input.showOnCard,input.showInList,input.sortOrder,input.active,user.id]);
      const next=await optionsSnapshot(client,companyId,inserted.rows[0].id);
      await audit(client,user,"configuration.option.create","option",next.id,null,next,companyId);
      return next;
    });
    res.status(201).json({option:value});
  }));
  router.patch("/companies/:companyId/configuration-options/:id",handler(async(req,res)=>{
    const input=parse(optionChange,req.body),target=id(req.params.id);
    const option=await transaction(pool,async client=>{
      const {companyId,user}=await authorized(client,req);
      await assertRequestPagesEnabled(client,req,true);
      const before=await optionsSnapshot(client,companyId,target);
      if(before.revision!==input.revision) throw changed();
      if(before.system && (before.valueType!==input.valueType ||
        JSON.stringify(before.choices)!==JSON.stringify(input.choices))) throw new HttpError(400,"protected","لا يمكن تغيير نوع أو قائمة خيار نظامي");
      const update=await client.query(`UPDATE option_definitions SET
        name=$1,description=$2,value_type=$3,default_value=$4::jsonb,choices=$5::jsonb,
        required=$6,searchable=$7,show_on_card=$8,show_in_list=$9,sort_order=$10,
        active=$11,revision=revision+1,updated_by=$12,updated_at=now()
        WHERE id=$13 AND company_id=$14 AND revision=$15 RETURNING id`,[
        input.name,input.description,input.valueType,JSON.stringify(input.defaultValue),
        JSON.stringify(input.choices),input.required,input.searchable,input.showOnCard,
        input.showInList,input.sortOrder,input.active,user.id,target,companyId,input.revision]);
      if(!update.rows.length) throw changed();
      const next=await optionsSnapshot(client,companyId,target);
      await audit(client,user,"configuration.option.update","option",next.id,before,next,companyId);
      return next;
    });
    res.json({option});
  }));
  router.post("/companies/:companyId/configuration-roles",handler(async(req,res)=>{
    const input=parse(roleInput,req.body);
    const role=await transaction(pool,async client=>{
      const {companyId,user}=await authorized(client,req,true);
      const inserted=await client.query(`INSERT INTO company_roles(company_id,key,name,description,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$5) RETURNING id`,[companyId,input.key,input.name,input.description,user.id]);
      const next=await currentRole(client,companyId,inserted.rows[0].id);
      await audit(client,user,"configuration.role.create","role",next.id,null,next,companyId);
      return next;
    });
    res.status(201).json({role});
  }));
  router.patch("/companies/:companyId/configuration-roles/:id",handler(async(req,res)=>{
    const input=parse(roleChange,req.body),target=id(req.params.id);
    const role=await transaction(pool,async client=>{
      const {companyId,user}=await authorized(client,req,true);
      const before=await currentRole(client,companyId,target);
      if(before.revision!==input.revision)throw changed();
      const updated=await client.query(`UPDATE company_roles SET name=$1,description=$2,active=$3,
        updated_by=$4 WHERE company_id=$5 AND id=$6 AND revision=$7 RETURNING id`,
        [input.name,input.description,input.active,user.id,companyId,target,input.revision]);
      if(!updated.rowCount)throw changed();
      const next=await currentRole(client,companyId,target);
      await audit(client,user,"configuration.role.update","role",next.id,before,next,companyId);
      return next;
    });
    res.json({role});
  }));
  router.post("/companies/:companyId/configuration-role-rules",handler(async(req,res)=>{
    const input=parse(ruleInput,req.body);
    const rule=await transaction(pool,async client=>{
      const {companyId,user}=await authorized(client,req,true);
      const role=await currentRole(client,companyId,input.roleId);
      if(!role.active)throw new HttpError(409,"inactive","الدور غير فعال");
      const permission=await client.query("SELECT active FROM permission_definitions WHERE key=$1",[input.permissionKey]);
      if(!permission.rows[0]?.active)throw new HttpError(400,"invalid_permission","الصلاحية غير موجودة أو غير فعالة");
      const inserted=await client.query(`INSERT INTO role_permission_rules(
        company_id,role_id,permission_key,effect,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$5) RETURNING id`,
        [companyId,input.roleId,input.permissionKey,input.effect,user.id]);
      const next=await currentRule(client,companyId,inserted.rows[0].id);
      await audit(client,user,"configuration.roleRule.create","rolePermissionRule",next.id,null,next,companyId);
      return next;
    });
    res.status(201).json({rule});
  }));
  router.patch("/companies/:companyId/configuration-role-rules/:id",handler(async(req,res)=>{
    const input=parse(ruleChange,req.body),target=id(req.params.id);
    const rule=await transaction(pool,async client=>{
      const {companyId,user}=await authorized(client,req,true);
      const before=await currentRule(client,companyId,target);
      if(before.revision!==input.revision)throw changed();
      const updated=await client.query(`UPDATE role_permission_rules SET effect=$1,active=$2,updated_by=$3
        WHERE company_id=$4 AND id=$5 AND revision=$6 RETURNING id`,
        [input.effect,input.active,user.id,companyId,target,input.revision]);
      if(!updated.rowCount)throw changed();
      const next=await currentRule(client,companyId,target);
      await audit(client,user,"configuration.roleRule.update","rolePermissionRule",next.id,before,next,companyId);
      return next;
    });
    res.json({rule});
  }));
  return router;
}
