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
import type { User } from "../../../packages/contracts/src/index.ts";

/** A phone is not verified ownership. Never advertise higher account roles
 * to a visitor-only browser session, even if the phone matches such an account. */
export function publicVisitorUser(user: User): User {
  return {...user,kind:"member",owner:false,editor:false,monitor:false};
}

const cookieName = "alraesy_visitor_device";
const cookiePath = "/api/auth/visitor/enter";
const days = 3650;
const visitorPhone = z.string().trim()
  .transform(v => v.replace(/[\s()\-]/g, "")
    .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))))
  .refine(v => /^\+?[0-9]{3,20}$/.test(v), "أدخل رقم هاتف صالحًا");
const entry = z.union([
  z.object({ phone: visitorPhone, name: z.string().trim().max(120).optional() }).strict(),
  z.object({ resume: z.literal(true) }).strict(),
]);

type AccountRow = {
  id:number; kind:string; owner:boolean; archived:boolean; suspended:boolean;
  editor:boolean; monitor:boolean; last_company_id:number|null;
  phone_verified_at:Date|null; phone:string;
};
/** A phone is not proof of ownership. Only completely unattached, unchanged
 * accounts can start by phone; returning participants require their trusted device. */
export async function visitorAccountStatus(db: Database, user: AccountRow): Promise<{
  hardProtected: boolean; hasActivity: boolean;
}> {
  // Only employees need a password for login. A phone-only session can never
  // open company or administrative routes even for an existing user.
  if (user.archived || user.suspended) return {hardProtected:true,hasActivity:true};
  const employed = await db.query(
    "SELECT EXISTS(SELECT 1 FROM employees WHERE user_id=$1) AS employed", [user.id],
  );
  // Disable the legacy published starter password for market users. They
  // authenticate through the market-only flow without needing any password.
  return {hardProtected:Boolean(employed.rows[0]?.employed),hasActivity:true};
}
function readDeviceCookie(req:Request):string|null {
  const key=(req.headers.cookie??"").split(";").map(s=>s.trim())
    .find(s=>s.startsWith(cookieName+"="))?.slice(cookieName.length+1);
  return key && /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
}
export function clearVisitorDeviceCookie(res:Response,secure:boolean) {
  res.clearCookie(cookieName,{httpOnly:true,sameSite:"lax",secure,path:cookiePath});
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
    const existingDevice=readDeviceCookie(req);
    res.setHeader("Cache-Control","no-store");
    if ("resume" in input && !existingDevice) {
      res.json({status:"not_authenticated"});
      return;
    }
    if ("phone" in input) limitAuth("visitor-phone:"+input.phone,25);
    const result=await transaction(pool,async db=>{
      let row;
      if ("resume" in input) {
        // A known-device credential, not a user ID sent by the browser,
        // identifies the account during automatic restoration.
        const found=await db.query(
          "SELECT u.* FROM visitor_device_tokens d JOIN users u ON u.id=d.user_id " +
          "WHERE d.token_hash=$1 AND d.expires_at>now() FOR UPDATE OF u",
          [tokenHash(existingDevice!)],
        );
        if (!found.rows.length) return {status:"not_authenticated" as const};
        row=found.rows[0];
      } else {
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",["visitor:"+input.phone]);
        const lookup=await db.query(
          "SELECT * FROM users WHERE phone=$1 OR phone_login_key=$1 ORDER BY id FOR UPDATE",
          [input.phone],
        );
        if(lookup.rows.length>1)return {status:"password_required" as const};
        row=lookup.rows[0];
        if(!row) {
          // A name is optional for the public directory. No usable
          // hardcoded starter password is issued to the new visitor.
          const visitorName=input.name?.trim() || "زائر";
          const secret=await passwordHash(randomBytes(24).toString("base64url"));
          const inserted=await db.query(
            "INSERT INTO users(name,display_name,email,phone,phone_login_key,image,password_hash) " +
            "VALUES($1,$1,'',$2,$2,'',$3) RETURNING *",
            [visitorName,input.phone,secret],
          );
          row=inserted.rows[0];
          await db.query(
            "INSERT INTO visitor_phone_accounts(user_id,default_password_active) VALUES($1,false)",
            [row.id],
          );
          const newcomer=userDTO(row);
          await audit(db,newcomer,"user.register","user",newcomer.id,null,newcomer);
        }
      }
      const status=await visitorAccountStatus(db,row);
      if(status.hardProtected) return {
        status: "resume" in input ? "not_authenticated" as const : "password_required" as const,
      };
      const user=userDTO(row);
      const deviceToken=randomBytes(32).toString("base64url");
      // Rotate and extend this trusted device. Never delete a credential
      // belonging to another account on a shared phone.
      if (existingDevice) await db.query(
        "DELETE FROM visitor_device_tokens WHERE user_id=$1 AND token_hash=$2",
        [row.id,tokenHash(existingDevice)],
      );
      await db.query(
        "INSERT INTO visitor_device_tokens(token_hash,user_id,expires_at) " +
        "VALUES($1,$2,now()+($3::int*interval '1 day'))",
        [tokenHash(deviceToken),row.id,days],
      );
      await db.query(
        "DELETE FROM visitor_device_tokens WHERE user_id=$1 AND expires_at<=now()",[row.id],
      );
      if(req.auth)await db.query(
        "DELETE FROM sessions WHERE token_hash=$1",[req.auth.tokenHash],
      );
      const session=await createSession(db,row.id,true);
      await audit(db,user,"auth.visitorLogin","user",row.id,null,null);
      return {status:"authenticated" as const,user,...session,deviceToken};
    });
    if(result.status!=="authenticated"){
      if(result.status==="not_authenticated" && existingDevice)
        clearVisitorDeviceCookie(res,secure);
      res.json(result);
      return;
    }
    await recordDeviceLogin(pool,req,result.user.id).catch(()=>{});
    setSessionCookie(res,result.token,secure,true);
    setDeviceCookie(res,result.deviceToken,secure);
    res.json({status:"authenticated",user:publicVisitorUser(result.user),csrf:result.csrf,visitorOnly:true});
  }));
  return router;
}
