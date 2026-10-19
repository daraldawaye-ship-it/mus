import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import {
  employeePositions,employeePositionListSchema,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor,handler,id,parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { companyAccess,currentActor,manageEmployees } from "./policies/access.ts";
import { audit } from "./services/audit.ts";
import { centralResources,centralResource } from "./services/central-access-catalog.ts";

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
        return {
          positions:employeePositions,
          resources:centralResources.map(resource=>({
            ...resource,
            policy:overrides.get(resource.key)??null,
          })),
        };
      });
      res.json(result);
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
