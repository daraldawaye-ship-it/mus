import { Router } from "express";
import type { Pool, QueryResultRow } from "pg";
import { z } from "zod";
import {
  employeePositions,employeePositionListSchema,permissionKeys,
  type Permission,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor,handler,id,parse } from "./http.ts";
import { deny, HttpError, missing } from "./errors.ts";
import { companyAccess,currentActor,manageEmployees } from "./policies/access.ts";
import { audit } from "./services/audit.ts";
import { centralResources,centralResource } from "./services/central-access-catalog.ts";
import { employeeDTO } from "./repositories/models.ts";

export const centralPermissionAssignmentSchema=z.object({
  granted:z.boolean(),
  expectedGranted:z.boolean(),
}).strict();

const permissionEmployeeSelect=`SELECT e.*,u.display_name,u.email,u.owner AS permission_owner
  FROM employees e JOIN users u ON u.id=e.user_id`;
const permissionEmployee=(row:QueryResultRow)=>({
  id:row.id as number,
  name:row.name as string,
  active:row.active as boolean,
  positions:row.position_keys as string[],
  permissions:row.permissions as Permission[],
  isGeneralManager:row.is_general_manager as boolean,
  isOwner:row.permission_owner as boolean,
});
const assertPositionPolicy=(key:string)=>{
  if(centralResource(key)?.kind==="permission")
    throw new HttpError(409,"permission_assignments_only",
      "تُدار صلاحيات التشغيل من تعيينات الموظفين داخل مركز الصلاحيات، وليس من حقول الصفات.");
};

const editSchema=z.object({
  viewPositions:employeePositionListSchema,
  editPositions:employeePositionListSchema,
  revision:z.number().int().positive().nullable(),
}).strict().superRefine((value,ctx)=>{
  for(const role of value.editPositions)
    if(!value.viewPositions.includes(role))
      ctx.addIssue({code:"custom",path:["editPositions"],message:"من يستطيع التعديل يجب أن يكون ضمن صفات الاطلاع"});
});
const keyFromParam=(value:unknown):string=>{
  if(typeof value!=="string"||!centralResource(value))
    throw new HttpError(404,"resource_not_found","العنصر غير معرف برمجيًا في دليل الصلاحيات");
  return value;
};
export function centralAccessRoutes(pool:Pool):Router {
  const router=Router();
  router.get("/companies/:companyId/central-access",
    handler(async(req,res)=>{
      const companyId=id(req.params.companyId);
      const result=await transaction(pool,async client=>{
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const user=await currentActor(client,actor(req),false);
        const context=await companyAccess(client,user,companyId);
        manageEmployees(user,context);
        const stored=await client.query(
          `SELECT resource_key AS key,view_positions AS "viewPositions",
           edit_positions AS "editPositions",revision,updated_at AS "updatedAt"
           FROM central_access_policies WHERE company_id=$1`,[companyId],
        );
        const overrides=new Map(stored.rows.map(row=>[row.key,row]));
        const employees=await client.query(
          `${permissionEmployeeSelect} WHERE e.company_id=$1 ORDER BY e.active DESC,e.name,e.id`,
          [companyId],
        );
        return {
          positions:employeePositions,
          permissionEmployees:employees.rows.map(permissionEmployee),
          resources:centralResources.map(resource=>({
            ...resource,
            // These old position presets were never an authorization source.
            // Show the actual employee grants without activating any preset.
            policy:resource.kind==="permission"?null:overrides.get(resource.key)??null,
            controlMode:resource.kind==="permission"?"employees":"positions",
          })),
        };
      });
      res.json(result);
    }),
  );
  router.patch("/companies/:companyId/central-access/:key/employees/:employeeId",
    handler(async(req,res)=>{
      const companyId=id(req.params.companyId),employeeId=id(req.params.employeeId);
      const key=keyFromParam(req.params.key);
      const permission=key.slice("permission:".length) as Permission;
      if(centralResource(key)?.kind!=="permission" || !permissionKeys.includes(permission))
        throw new HttpError(400,"invalid_permission","اختر صلاحية تشغيل معرّفة");
      const input=parse(centralPermissionAssignmentSchema,req.body);
      const employee=await transaction(pool,async client=>{
        const user=await currentActor(client,actor(req));
        const context=await companyAccess(client,user,companyId,undefined,true);
        manageEmployees(user,context);
        const found=await client.query(
          `${permissionEmployeeSelect} WHERE e.company_id=$1 AND e.id=$2 FOR UPDATE OF e`,
          [companyId,employeeId],
        );
        const row=found.rows[0];
        if(!row) missing();
        if(row.permission_owner)
          deny("صلاحيات مالك المنصة ثابتة ولا تُعدّل من تعيينات الموظفين");
        if(row.is_general_manager && !user.owner)
          deny("تعديل صلاحيات المدير العام للمالك فقط");
        const before=employeeDTO(row);
        const granted=before.permissions.includes(permission);
        if(granted!==input.expectedGranted)
          throw new HttpError(409,"stale_permission_assignment",
            "تغيّر تعيين هذه الصلاحية؛ أعد تحميل آخر صلاحيات الموظف");
        if(granted===input.granted) return permissionEmployee(row);
        const permissions=input.granted
          ? [...before.permissions,permission].sort()
          : before.permissions.filter(value=>value!==permission);
        await client.query(
          "UPDATE employees SET permissions=$1 WHERE company_id=$2 AND id=$3",
          [permissions,companyId,employeeId],
        );
        const after=await client.query(
          `${permissionEmployeeSelect} WHERE e.company_id=$1 AND e.id=$2`,
          [companyId,employeeId],
        );
        await audit(client,user,"employee.update","employee",employeeId,
          before,employeeDTO(after.rows[0]!),companyId);
        return permissionEmployee(after.rows[0]!);
      });
      res.json({employee});
    }),
  );
  router.put("/companies/:companyId/central-access/:key",
    handler(async(req,res)=>{
      const companyId=id(req.params.companyId);
      const key=keyFromParam(req.params.key);
      const input=parse(editSchema,req.body);
      const result=await transaction(pool,async client=>{
        const user=await currentActor(client,actor(req));
        const context=await companyAccess(client,user,companyId,undefined,true);
        manageEmployees(user,context);
        assertPositionPolicy(key);
        const existing=await client.query(
          `SELECT view_positions AS "viewPositions",
           edit_positions AS "editPositions",revision FROM central_access_policies
           WHERE company_id=$1 AND resource_key=$2 FOR UPDATE`,
          [companyId,key],
        );
        const previous=existing.rows[0]??null;
        if((previous?.revision??null)!==input.revision)
          throw new HttpError(409,"stale_policy","عدّل مستخدم آخر هذا العنصر؛ أعد تحميل آخر صلاحياته");
        if(previous) {
          await client.query(
            `UPDATE central_access_policies SET
               view_positions=$1,edit_positions=$2,revision=revision+1,
               updated_by=$3,updated_at=clock_timestamp()
             WHERE company_id=$4 AND resource_key=$5`,
            [input.viewPositions,input.editPositions,user.id,companyId,key],
          );
        }else{
          await client.query(
            `INSERT INTO central_access_policies
              (company_id,resource_key,view_positions,edit_positions,updated_by)
              VALUES($1,$2,$3,$4,$5)`,
            [companyId,key,input.viewPositions,input.editPositions,user.id],
          );
        }
        const current=await client.query(
          `SELECT resource_key AS key,view_positions AS "viewPositions",
            edit_positions AS "editPositions",revision,updated_at AS "updatedAt"
           FROM central_access_policies WHERE company_id=$1 AND resource_key=$2`,
          [companyId,key],
        );
        await audit(client,user,"centralAccess.update","centralAccess",
          null,previous,current.rows[0],companyId);
        return current.rows[0];
      });
      res.json({policy:result});
    }),
  );
  router.delete("/companies/:companyId/central-access/:key",
    handler(async(req,res)=>{
      const companyId=id(req.params.companyId),key=keyFromParam(req.params.key);
      const input=parse(z.object({revision:z.number().int().positive()}).strict(),req.body);
      await transaction(pool,async client=>{
        const user=await currentActor(client,actor(req));
        const context=await companyAccess(client,user,companyId,undefined,true);
        manageEmployees(user,context);
        assertPositionPolicy(key);
        const before=await client.query(
          `SELECT view_positions AS "viewPositions",edit_positions AS "editPositions",
           revision FROM central_access_policies
           WHERE company_id=$1 AND resource_key=$2 FOR UPDATE`,
          [companyId,key],
        );
        if(!before.rows[0]||before.rows[0].revision!==input.revision)
          throw new HttpError(409,"stale_policy","أعد تحميل آخر نسخة للصلاحيات");
        await client.query(
          "DELETE FROM central_access_policies WHERE company_id=$1 AND resource_key=$2",
          [companyId,key],
        );
        await audit(client,user,"centralAccess.reset","centralAccess",
          null,before.rows[0],null,companyId);
      });
      res.json({ok:true});
    }),
  );
  return router;
}
