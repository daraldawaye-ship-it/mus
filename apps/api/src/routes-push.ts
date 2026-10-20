import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { actor, handler, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import {
  hashEndpoint,pushPublicKey,pushReady,validPushEndpoint,validPushKeys,
} from "./services/web-push.ts";

const subscription=z.object({
  endpoint:z.string().min(1).max(2048),
  keys:z.object({
    p256dh:z.string().min(1).max(128),
    auth:z.string().min(1).max(128),
  }).strict(),
}).strict();
const unsubscribe=z.object({endpoint:z.string().min(1).max(2048)}).strict();
export function pushRoutes(pool:Pool):Router{
  const router=Router();
  router.get("/push/config",handler(async(req,res)=>{
    actor(req);
    res.json({enabled:pushReady,publicKey:pushPublicKey});
  }));
  router.get("/push/status",handler(async(req,res)=>{
    const user=actor(req);
    const result=await pool.query(
      "SELECT count(*)::integer AS count FROM web_push_subscriptions"+
      " WHERE user_id=$1 AND session_hash=$2",
      [user.id,req.auth!.tokenHash]);
    res.json({devices:result.rows[0].count});
  }));
  router.post("/push/subscribe",handler(async(req,res)=>{
    const user=actor(req);
    if(!pushReady)throw new HttpError(503,"push_unavailable","خدمة إشعارات الأجهزة غير مهيأة");
    const input=parse(subscription,req.body);
    if(!validPushEndpoint(input.endpoint)||!validPushKeys(input.keys.p256dh,input.keys.auth))
      throw new HttpError(400,"invalid_subscription","بيانات اشتراك الإشعارات غير صالحة");
    // The endpoint must belong to a browser PushManager. Limit devices per user
    // to prevent accidental unbounded subscriptions.
    await pool.query(
      "INSERT INTO web_push_subscriptions(user_id,session_hash,endpoint_hash,endpoint,p256dh,auth)"+
      " VALUES($1,$2,$3,$4,$5,$6)"+
      " ON CONFLICT(endpoint_hash) DO UPDATE SET"+
      " user_id=EXCLUDED.user_id,session_hash=EXCLUDED.session_hash,"+
      " endpoint=EXCLUDED.endpoint,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,"+
      " updated_at=clock_timestamp()",
      [user.id,req.auth!.tokenHash,hashEndpoint(input.endpoint),
        input.endpoint,input.keys.p256dh,input.keys.auth]);
    // Reusing an existing endpoint may reassign the subscriber (device login).
    // Prune expired session rows while preserving other active devices.
    await pool.query(
      "DELETE FROM web_push_subscriptions p WHERE p.user_id=$1"+
      " AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.token_hash=p.session_hash"+
      " AND s.user_id=p.user_id AND s.expires_at>clock_timestamp())",
      [user.id]);
    res.json({enabled:true});
  }));
  router.post("/push/unsubscribe",handler(async(req,res)=>{
    const user=actor(req);
    const input=parse(unsubscribe,req.body);
    await pool.query(
      "DELETE FROM web_push_subscriptions WHERE user_id=$1 AND session_hash=$2 AND endpoint_hash=$3",
      [user.id,req.auth!.tokenHash,hashEndpoint(input.endpoint)]);
    res.json({enabled:false});
  }));
  return router;
}
