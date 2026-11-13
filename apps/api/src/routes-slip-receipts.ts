import { Router } from "express";
import type { Pool } from "pg";
import { slipReceiptSchema } from "../../../packages/contracts/src/slip-receipts.ts";
import { actor,handler,id,parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess,currentActor } from "./policies/access.ts";
import { mutateMaster } from "./services/masters.ts";
import { directoryEntries,assertDirectoryAccess } from "./services/pages.ts";
import { listQuery } from "./services/lists.ts";
import { HttpError } from "./errors.ts";
import { listSlipMovements,receiveSlips } from "./services/slip-receipts.ts";
import type { CompanyContext } from "../../../packages/contracts/src/index.ts";

export function assertSlipCashier(context:CompanyContext) {
  if(!context.general && !context.employee?.positions.includes("cashier"))
    throw new HttpError(403,"slips_cashier_only","متابعة واستلام القصاصات متاحة للمالك وأمين الصندوق فقط");
}
export function slipReceiptRoutes(pool:Pool) {
  const router=Router(),path="/companies/:companyId/slip-movements";
  router.get(path,handler(async(req,res)=>{
    const paging=listQuery(req.query,{id:"id"});
    res.json(await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user=await currentActor(client,actor(req),false),companyId=id(req.params.companyId);
      assertSlipCashier(await companyAccess(client,user,companyId,"finance.view"));
      const entry=(await directoryEntries(client,user,companyId)).find(page=>page.key==="company.slip-movements");
      if(!entry)throw new HttpError(403,"slips_page_missing","صفحة القصاصات غير متاحة");
      assertDirectoryAccess(entry,"view");
      return listSlipMovements(client,companyId,paging.pageSize,paging.offset);
    }));
  }));
  router.post(path,handler(async(req,res)=>{
    const input=parse(slipReceiptSchema,req.body);
    const result=await mutateMaster(pool,req,"finance.post",async(client,user,companyId)=>{
      assertSlipCashier(await companyAccess(client,user,companyId));
      const entry=(await directoryEntries(client,user,companyId)).find(page=>page.key==="company.slip-movements");
      if(!entry)throw new HttpError(403,"slips_page_missing","صفحة القصاصات غير متاحة");
      assertDirectoryAccess(entry,"post");
      return receiveSlips(client,companyId,user,input);
    });
    res.status(201).json(result);
  }));
  return router;
}
