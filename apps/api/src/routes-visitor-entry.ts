import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction, type Database } from "./db.ts";
import { handler, parse, setSessionCookie } from "./http.ts";
import { audit } from "./services/audit.ts";
import { authLimiter, createSession, passwordHash, tokenHash } from "./services/auth.ts";
import { recordDeviceLogin } from "./services/user-device-activity.ts";
import { userDTO } from "./repositories/models.ts";

const cookieName = "alraesy_visitor_device";
const cookiePath = "/api/auth/visitor/enter";
const days = 180;
const visitorPhone = z.string().trim()
  .transform(v => v.replace(/[\s()\-]/g, "")
    .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))))
  .refine(v => /^\+?[0-9]{3,20}$/.test(v), "أدخل رقم هاتف صالحًا");
const entry = z.object({
  phone: visitorPhone,
  name: z.string().trim().min(1).max(120).optional(),
}).strict();

type AccountRow = {
  id:number; kind:string; owner:boolean; archived:boolean; suspended:boolean;
  editor:boolean; monitor:boolean; last_company_id:number|null;
  phone_verified_at:Date|null; phone:string;
};
/** A phone is not proof of ownership. Only completely unattached, unchanged
 * accounts can start by phone; returning participants require their trusted device. */
export async function visitorAccountStatus(db: Database, user:AccountRow):Promise<{
  hardProtected:boolean; hasActivity:boolean;
}> {
  if (user.owner || user.kind !== "member" || user.archived || user.suspended ||
    user.editor || user.monitor || user.last_company_id || user.phone_verified_at)
    return {hardProtected:true,hasActivity:true};
  const check = await db.query(
    "SELECT " +
    "EXISTS(SELECT 1 FROM employees WHERE user_id=$1 OR created_by=$1) AS employment," +
    "EXISTS(SELECT 1 FROM companies WHERE created_by=$1) AS companies," +
    "EXISTS(SELECT 1 FROM social_identities WHERE user_id=$1) AS social," +
    "EXISTS(SELECT 1 FROM user_device_activity WHERE user_id=$1 AND device_kind IN ('android_app','iphone_app')) AS installed," +
    "EXISTS(SELECT 1 FROM audit_events WHERE (actor_id=$1 AND action IN ('auth.password','user.profile')) OR " +
      "(target_type='user' AND target_id=$1 AND " +
      "(action IN ('auth.password','user.update','auth.loginLinkIssue') OR " +
      "(action='user.register' AND actor_id IS DISTINCT FROM $1)))) AS protected_change," +
    "EXISTS(SELECT 1 FROM audit_events WHERE actor_id=$1 AND action NOT IN " +
      "('user.register','auth.login','auth.logout','auth.visitorLogin','page.open')) AS acted," +
    "EXISTS(SELECT 1 FROM medicine_market_contributions WHERE author_id=$1) OR " +
    "EXISTS(SELECT 1 FROM medicine_market_cards WHERE created_by=$1) OR " +
    "EXISTS(SELECT 1 FROM medicine_market_comments WHERE author_id=$1) OR " +
    "EXISTS(SELECT 1 FROM medicine_market_reactions WHERE user_id=$1) AS contributed",
    [user.id],
  );
  const a=check.rows[0];
  return {
    hardProtected:Boolean(a.employment || a.companies || a.social || a.protected_change),
    hasActivity:Boolean(a.installed || a.acted || a.contributed),
  };
}
function readDeviceCookie(req:Request):string|null {
  const key=(req.headers.cookie??"").split(";").map(s=>s.trim())
    .find(s=>s.startsWith(cookieName+"="))?.slice(cookieName.length+1);
  return key && /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
}
function setDeviceCookie(res:Response,token:string,secure:boolean) {
  res.cookie(cookieName,token,{httpOnly:true,sameSite:"lax",secure,
    path:cookiePath,maxAge:days*24*60*60*1000});
}
export function visitorEntryRoutes(pool:Pool,secure:boolean):Router {
  const router=Router(),limitAuth=authLimiter();
  router.post("/auth/visitor/enter",handler(async(req,res)=>{
    limitAuth("visitor-ip:"+req.ip,100);
    const input=parse(entry,req.body);
    limitAuth("visitor-phone:"+input.phone,25);
    const existingDevice=readDeviceCookie(req);
    // A phone-scoped transactional lock prevents duplicate accounts.
    const result=await transaction(pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",["visitor:"+input.phone]);
      const lookup=await db.query("SELECT * FROM users WHERE phone=$1 OR phone_login_key=$1 ORDER BY id FOR UPDATE",[input.phone]);
      if(lookup.rows.length>1)return {status:"password_required" as const};
      let row=lookup.rows[0];
      if(row){
        const current=await visitorAccountStatus(db,row);
        if(current.hardProtected)return {status:"password_required" as const};
        let trusted=false;
        if(existingDevice){
          const credentials=await db.query(
            "SELECT 1 FROM visitor_device_tokens WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()",
            [row.id,tokenHash(existingDevice)]);
          trusted=Boolean(credentials.rowCount);
        }
        if(current.hasActivity&&!trusted)return {status:"password_required" as const};
      }else{
        if(!input.name)return {status:"name_required" as const};
        const hash=await passwordHash("1234");
        const inserted=await db.query(
          "INSERT INTO users(name,display_name,email,phone,phone_login_key,image,password_hash) " +
          "VALUES($1,$1,'',$2,$2,'',$3) RETURNING *",
          [input.name,input.phone,hash]);
        row=inserted.rows[0];
        await db.query("INSERT INTO visitor_phone_accounts(user_id) VALUES($1)",[row.id]);
        const newcomer=userDTO(row);
        await audit(db,newcomer,"user.register","user",newcomer.id,null,newcomer);
      }
      const user=userDTO(row);
      const deviceToken=randomBytes(32).toString("base64url");
      await db.query("INSERT INTO visitor_device_tokens(token_hash,user_id,expires_at) " +
        "VALUES($1,$2,now()+interval '180 days')",
        [tokenHash(deviceToken),row.id]);
      await db.query("DELETE FROM visitor_device_tokens WHERE user_id=$1 AND expires_at<=now()",[row.id]);
      if(req.auth)await db.query("DELETE FROM sessions WHERE token_hash=$1",[req.auth.tokenHash]);
      const session=await createSession(db,row.id);
      await db.query("UPDATE sessions SET visitor_only=true WHERE token_hash=$1",[tokenHash(session.token)]);
      await audit(db,user,"auth.visitorLogin","user",row.id,null,null);
      return {status:"authenticated" as const,user,...session,deviceToken};
    });
    if(result.status!=="authenticated"){
      res.json(result);
      return;
    }
    await recordDeviceLogin(pool,req,result.user.id).catch(()=>{});
    setSessionCookie(res,result.token,secure);
    setDeviceCookie(res,result.deviceToken,secure);
    res.setHeader("Cache-Control","no-store");
    res.json({status:"authenticated",user:result.user,csrf:result.csrf,visitorOnly:true});
  }));
  return router;
}
