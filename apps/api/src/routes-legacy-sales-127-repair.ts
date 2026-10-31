import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import {
  assertLegacy127Scope, legacy127Summary, repairNextLegacy127,
} from "./services/legacy-sales-127-repair.ts";

/** A single, narrowly scoped original import batch. Not a generic posting/reset API. */
export function legacySales127RepairRoutes(pool: Pool): Router {
  const router = Router();
  const path = "/companies/:companyId/transaction-import/repair-20261030";
  const authorize = async (client: import("pg").PoolClient, req: import("express").Request, writable: boolean) => {
    const companyId = id(req.params.companyId);
    if (companyId !== 2)
      throw new HttpError(404, "not_found", "هذه العملية تخص دفعة دار الدواء المحددة فقط");
    const user = await currentActor(client, actor(req), !writable);
    ownerOnly(user);
    if (user.suspended)
      throw new HttpError(403, "forbidden", "الحساب موقوف");
    await companyAccess(client,user,2,undefined,writable);
    await assertRequestPagesEnabled(client,req,writable);
    return user;
  };
  router.get(path,handler(async(req,res)=>{
    const summary=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await authorize(client,req,false);
      const result=await legacy127Summary(client);
      assertLegacy127Scope(result);
      return result;
    });
    res.setHeader("Cache-Control","private, no-store");
    res.json({summary,readOnly:true});
  }));
  router.post(path,handler(async(req,res)=>{
    const {limit}=parse(z.object({limit:z.number().int().min(1).max(5).default(5)}).strict(),req.body);
    const result=await transaction(pool,async client=>{
      const user=await authorize(client,req,true);
      return repairNextLegacy127(client,user,limit);
    });
    res.json({ ...result, completed: result.summary.remaining===0 });
  }));
  return router;
}
