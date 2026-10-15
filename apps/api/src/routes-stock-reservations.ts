import { Router } from "express";
import type { Pool } from "pg";
import {
 stockReservationSchema,stockReservationReleaseSchema,
} from "../../../packages/contracts/src/inventory.ts";
import { actor,handler,id,parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess,currentActor } from "./policies/access.ts";
import { mutateMaster } from "./services/masters.ts";
import {
 requireReservationView,getReservation,createReservation,releaseReservation,
 readItemReservationAvailability,
} from "./services/stock-reservations.ts";

export function stockReservationRoutes(pool:Pool):Router {
 const router=Router(),base="/companies/:companyId";
 router.get(`${base}/items/:itemId/reservation-availability`,handler(async(req,res)=>{
  const itemId=id(req.params.itemId),companyId=id(req.params.companyId);
  const result=await transaction(pool,async client=>{
   await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
   const user=await currentActor(client,actor(req),false);
   await companyAccess(client,user,companyId,"inventory.view");
   await requireReservationView(client,user,companyId);
   return readItemReservationAvailability(client,companyId,itemId);
  });
  res.json({availability:result});
 }));
 router.get(`${base}/stock-reservations/:id`,handler(async(req,res)=>{
  const companyId=id(req.params.companyId),reservationId=id(req.params.id);
  const reservation=await transaction(pool,async client=>{
   await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
   const user=await currentActor(client,actor(req),false);
   await companyAccess(client,user,companyId,"inventory.view");
   await requireReservationView(client,user,companyId);
   return getReservation(client,companyId,reservationId);
  });
  res.json({reservation});
 }));
 router.post(`${base}/stock-reservations`,handler(async(req,res)=>{
  const input=parse(stockReservationSchema,req.body);
  const result=await mutateMaster(pool,req,"inventory.post",async(client,user,companyId)=>{
   await requireReservationView(client,user,companyId);
   return createReservation(client,user,companyId,input);
  });
  res.status(result.created?201:200).json({reservation:result.reservation});
 }));
 router.post(`${base}/stock-reservations/:id/release`,handler(async(req,res)=>{
  const reservationId=id(req.params.id);
  const input=parse(stockReservationReleaseSchema,req.body);
  const result=await mutateMaster(pool,req,"inventory.post",async(client,user,companyId)=>{
   await requireReservationView(client,user,companyId);
   return releaseReservation(client,user,companyId,reservationId,input);
  });
  res.status(result.created?201:200).json({reservation:result.reservation});
 }));
 return router;
}
