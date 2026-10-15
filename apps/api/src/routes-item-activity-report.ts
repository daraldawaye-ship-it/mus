import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { actor,handler,parse } from "./http.ts";
import { readItems } from "./services/items.ts";
import { readItemActivityReport } from "./services/item-activity-report.ts";

const query=z.object({
 q:z.string().trim().max(120).default(""),
 active:z.enum(["active","archived","all"]).default("active"),
 page:z.coerce.number().int().min(1).max(100000).default(1),
 pageSize:z.coerce.number().int().min(1).max(100).default(50),
 sortBy:z.enum(["code","name",
    "saleOneMonth","saleFourMonths","saleTwelveMonths","saleAllTime",
    "purchaseOneMonth","purchaseFourMonths","purchaseTwelveMonths","purchaseAllTime"]).default("code"),
 sortDir:z.enum(["asc","desc"]).default("asc"),
}).strict();
export function itemActivityReportRoutes(pool:Pool):Router {
 const router=Router();
 router.get("/companies/:companyId/item-statistics-report",handler(async(req,res)=>{
   const options=parse(query,req.query);
   const report=await readItems(pool,req,(client,companyId)=>
     readItemActivityReport(client,actor(req),companyId,options));
   res.json({report});
 }));
 return router;
}
