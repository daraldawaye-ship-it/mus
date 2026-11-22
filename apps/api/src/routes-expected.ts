import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import type { User } from "../../../packages/contracts/src/index.ts";
import type { PageAction } from "../../../packages/contracts/src/pages.ts";
import { expectedCardCreateSchema, expectedMovementPatchSchema, expectedMovementCompleteSchema } from "../../../packages/contracts/src/expected.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { currentActor, companyAccess } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";
import { directoryEntries, assertDirectoryAccess, assertRequestPagesEnabled } from "./services/pages.ts";
import { createExpectedCard, readExpectedCard, listExpectedCards, listExpectedMovements, expectedSections, expectedAccounts, updateExpectedMovement, completeExpectedMovement } from "./services/expected.ts";

export function expectedRoutes(pool:Pool):Router {
  const router=Router();
  const base="/companies/:companyId";
  async function authorized<T>(req:Request,pageKey:string,action:PageAction,run:(client:PoolClient,user:User,companyId:number)=>Promise<T>):Promise<T> {
    return transaction(pool,async client=>{
      const write=action!=="view";
      if(!write) await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user=await currentActor(client,actor(req),write);
      if(write && user.suspended) throw new HttpError(403,"forbidden","الحساب موقوف عن المشاركة");
      const companyId=id(req.params.companyId);
      await companyAccess(client,user,companyId,undefined,write);
      await assertRequestPagesEnabled(client,req,write);
      const entry=(await directoryEntries(client,user,companyId)).find(value=>value.key===pageKey);
      if(!entry) missing("صفحة المتوقع غير مسجلة");
      assertDirectoryAccess(entry);
      if(write) assertDirectoryAccess(entry,action);
      return run(client,user,companyId);
    });
  }
  router.get(`${base}/expected-cards`,handler(async(req,res)=>{
    res.set("Cache-Control","private, no-store");
    res.json(await authorized(req,"company.expected-cards","view",(client,_user,companyId)=>listExpectedCards(client,companyId,req.query)));
  }));
  router.get(`${base}/expected-cards/:id`,handler(async(req,res)=>{
    res.set("Cache-Control","private, no-store");
    res.json({card:await authorized(req,"company.expected-cards","view",(client,_user,companyId)=>readExpectedCard(client,companyId,id(req.params.id)))});
  }));
  router.post(`${base}/expected-cards`,handler(async(req,res)=>{
    const input=parse(expectedCardCreateSchema,req.body);
    const result=await authorized(req,"company.expected-cards","create",(client,user,companyId)=>createExpectedCard(client,user,companyId,input));
    res.status(result.created?201:200).json({card:result.card});
  }));
  router.get(`${base}/expected-sections`,handler(async(req,res)=>{
    res.set("Cache-Control","private, no-store");
    res.json(await authorized(req,"company.expected-cards","view",(client,_user,companyId)=>expectedSections(client,companyId,req.query.q)));
  }));
  router.get(`${base}/expected-accounts`,handler(async(req,res)=>{
    res.set("Cache-Control","private, no-store");
    res.json(await authorized(req,"company.expected-cards","view",(client,_user,companyId)=>expectedAccounts(client,companyId,req.query)));
  }));
  router.get(`${base}/expected-movements`,handler(async(req,res)=>{
    res.set("Cache-Control","private, no-store");
    res.json(await authorized(req,"company.expected-movements","view",(client,_user,companyId)=>listExpectedMovements(client,companyId,req.query)));
  }));
  router.get(`${base}/expected-movements/sections`,handler(async(req,res)=>{
    res.set("Cache-Control","private, no-store");
    res.json(await authorized(req,"company.expected-movements","view",(client,_user,companyId)=>expectedSections(client,companyId,req.query.q)));
  }));
  router.patch(`${base}/expected-movements/:id`,handler(async(req,res)=>{
    const input=parse(expectedMovementPatchSchema,req.body);
    res.json({movement:await authorized(req,"company.expected-movements","edit",(client,user,companyId)=>updateExpectedMovement(client,user,companyId,id(req.params.id),input))});
  }));
  router.post(`${base}/expected-movements/:id/complete`,handler(async(req,res)=>{
    const input=parse(expectedMovementCompleteSchema,req.body);
    res.json({movement:await authorized(req,"company.expected-movements","edit",(client,user,companyId)=>completeExpectedMovement(client,user,companyId,id(req.params.id),input.revision))});
  }));
  return router;
}
