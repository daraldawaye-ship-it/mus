import express, { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { transaction } from "./db.ts";
import { handler, loadSession } from "./http.ts";
import { currentActor, publicAdmin } from "./policies/access.ts";
import { tokenHash, authLimiter } from "./services/auth.ts";
import { HttpError } from "./errors.ts";

const SCOPE="general_table.read";
const WRITE_SCOPE="general_table.read general_table.write";
const ALRAESY_READ="alraesy.read";
const ALRAESY_WRITE="alraesy.read alraesy.write";
const token=()=>randomBytes(32).toString("base64url");
const hashPkce=(v:string)=>createHash("sha256").update(v).digest("base64url");
const safe=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const str=(v:unknown)=>typeof v==="string"?v:"";
const form=express.urlencoded({extended:false,limit:"12kb"});
const webPage=(title:string,body:string)=>`<!doctype html><html lang="ar" dir="rtl">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${safe(title)}</title>
<style>body{font:16px system-ui,Tahoma;background:#f2f5fa;padding:25px;color:#172838}main{max-width:630px;margin:auto;background:white;padding:25px;border-radius:12px}p,li{line-height:1.8}button,a.primary{background:#1468aa;color:white;border:0;border-radius:8px;padding:12px 18px;font:inherit;cursor:pointer;text-decoration:none}</style>
<main><h2>${safe(title)}</h2>${body}</main></html>`;
const redirectAllowed=(raw:string,production:boolean)=>{
  try {
    const u=new URL(raw);
    if(u.username||u.password||u.hash)return false;
    if(!production&&u.protocol==="http:"&&["localhost","127.0.0.1"].includes(u.hostname))return true;
    return u.protocol==="https:"&&
      ["chatgpt.com","chat.openai.com","platform.openai.com"].includes(u.hostname)&&
      (u.pathname.startsWith("/connector/")||u.pathname==="/connector_platform_oauth_redirect");
  }catch{return false;}
};
export function chatgptOauthRoutes(pool:Pool,origin:string,production:boolean):Router {
  const router=Router(),limit=authLimiter(),sessions=loadSession(pool);
  const resource=origin+"/mcp";
  const alraesyResource=origin+"/mcp/alraesy";
  const alraesyScopeInfo={resource:alraesyResource,authorization_servers:[origin],
    scopes_supported:[ALRAESY_READ,"alraesy.write"],bearer_methods_supported:["header"]};
  const scopeInfo={resource,authorization_servers:[origin],scopes_supported:[SCOPE,"general_table.write"],bearer_methods_supported:["header"]};
  router.get("/.well-known/oauth-protected-resource",(_req,res)=>res.json(scopeInfo));
  router.get("/.well-known/oauth-protected-resource/mcp",(_req,res)=>res.json(scopeInfo));
  router.get("/.well-known/oauth-protected-resource/mcp/alraesy",(_req,res)=>res.json(alraesyScopeInfo));
  router.get("/.well-known/oauth-authorization-server",(_req,res)=>res.json({
    issuer:origin,authorization_endpoint:origin+"/oauth/authorize",token_endpoint:origin+"/oauth/token",
    registration_endpoint:origin+"/oauth/register",response_types_supported:["code"],
    grant_types_supported:["authorization_code","refresh_token"],token_endpoint_auth_methods_supported:["none"],
    scopes_supported:[SCOPE,"general_table.write",ALRAESY_READ,"alraesy.write"],
    code_challenge_methods_supported:["S256"],
    authorization_response_iss_parameter_supported:true,client_id_metadata_document_supported:false,
  }));
  router.post("/oauth/register",express.json({limit:"8kb"}),handler(async(req,res)=>{
    limit("chatgpt-register:"+req.ip,20);
    const body=req.body as Record<string,unknown>,uris=body?.redirect_uris;
    if(!Array.isArray(uris)||!uris.length||uris.length>4||
      !uris.every(u=>typeof u==="string"&&redirectAllowed(u,production))||
      (body.token_endpoint_auth_method!==undefined&&body.token_endpoint_auth_method!=="none")||
      (body.response_types!==undefined&&JSON.stringify(body.response_types)!=='["code"]')||
      (body.grant_types!==undefined&&
        ( !Array.isArray(body.grant_types) || body.grant_types.some(g=>!["authorization_code","refresh_token"].includes(g)))))
      throw new HttpError(400,"invalid_client_metadata","رابط عودة تطبيق ChatGPT غير صالح");
    const clientId="tijara_"+token();
    await pool.query("INSERT INTO chatgpt_oauth_clients(client_id,redirect_uris) VALUES($1,$2::jsonb)",
      [clientId,JSON.stringify(uris)]);
    res.status(201).json({client_id:clientId,client_name:"ChatGPT",redirect_uris:uris,
      response_types:["code"],grant_types:["authorization_code","refresh_token"],
      token_endpoint_auth_method:"none"});
  }));
  async function validate(input:Record<string,unknown>){
    const clientId=str(input.client_id),redirectUri=str(input.redirect_uri),
      challenge=str(input.code_challenge),state=str(input.state),requested=str(input.resource);
    if(input.response_type!=="code"||input.code_challenge_method!=="S256"||
      !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)||state.length<8||state.length>512||
      !(requested===alraesyResource ?
        [ALRAESY_READ,ALRAESY_WRITE].includes(str(input.scope)) :
        [origin,resource].includes(requested)&&[SCOPE,WRITE_SCOPE].includes(str(input.scope))))
      throw new HttpError(400,"invalid_request","معلمات تفويض ChatGPT غير صحيحة");
    const row=(await pool.query<{redirect_uris:string[]}>(
      "SELECT redirect_uris FROM chatgpt_oauth_clients WHERE client_id=$1",[clientId])).rows[0];
    if(!row||!row.redirect_uris.includes(redirectUri))
      throw new HttpError(400,"invalid_client","تطبيق ChatGPT غير مسجل");
    return {clientId,redirectUri,challenge,state,requested,scope:str(input.scope)};
  }
  router.get("/oauth/authorize",sessions,handler(async(req,res)=>{
    await validate(req.query);
    res.setHeader("Cache-Control","no-store");
    if(!req.auth){
      const redirect="/login?returnTo="+encodeURIComponent(req.originalUrl);
      res.status(401).type("html").send(webPage("الربط مع ChatGPT",
        `<p>سجّل الدخول بحسابك في الموقع أولًا ثم وافق على الصلاحيات المحددة.</p><a class="primary" href="${safe(redirect)}">تسجيل الدخول والمتابعة</a>`));
      return;
    }
    if(req.query.resource!==alraesyResource) publicAdmin(req.auth.user);
    const params=["client_id","redirect_uri","code_challenge","code_challenge_method",
      "response_type","state","scope","resource"].map(key=>
      `<input type="hidden" name="${key}" value="${safe(req.query[key])}">`).join("");
    const alraesy=req.query.resource===alraesyResource;
    res.type("html").send(webPage(alraesy?"ربط الرئيسي مع ChatGPT":"السماح لـ ChatGPT بقراءة بيانات تجارة",
      `<p>الحساب: <strong>${safe(req.auth.user.displayName)}</strong></p>
      <p>الصلاحيات المطلوبة: <strong>${alraesy ?
        (req.query.scope===ALRAESY_WRITE?"قراءة وتنفيذ عمليات الموقع ضمن صلاحيات حسابك":"قراءة بيانات الموقع المسموح لك بها") :
        (req.query.scope===WRITE_SCOPE?"قراءة وإنشاء وتعديل سجلات الجدول العام":"قراءة سجلات الجدول العام فقط")}</strong>.</p>
      <p>${alraesy?"ستطبق صلاحيات المستخدم والشركة والصفحة والسجل كما في الموقع؛ تغيير كلمة المرور عبر صفحة الحساب الآمنة فقط.":"لا توجد صلاحية للحذف أو الوصول إلى حسابات الشركات وفواتيرها."}</p>
      <p>يمكن إلغاء الاتصال في أي وقت من <a href="/oauth/connections">إدارة الاتصالات</a>.</p>
      <form action="/oauth/authorize" method="post">${params}
      <input type="hidden" name="csrf" value="${safe(req.auth.csrf)}">
      <button type="submit">${[WRITE_SCOPE,ALRAESY_WRITE].includes(String(req.query.scope))?"أوافق على القراءة والتعديل ضمن صلاحياتي":"أوافق على القراءة فقط"}</button></form>`));
  }));
  router.post("/oauth/authorize",form,sessions,handler(async(req,res)=>{
    if(!req.auth||req.body?.csrf!==req.auth.csrf)
      throw new HttpError(403,"csrf","يجب تسجيل الدخول والتصريح بالطلب");
    const details=await validate(req.body);
    const current=await currentActor(pool,req.auth.user,false);
    if(details.requested!==alraesyResource) publicAdmin(current);
    const code=token();
    await transaction(pool,async(db)=>{
      await db.query("DELETE FROM chatgpt_oauth_codes WHERE expires_at<now()");
      await db.query(`INSERT INTO chatgpt_oauth_codes
      (code_hash,client_id,user_id,redirect_uri,code_challenge,resource,scope,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')`,
      [tokenHash(code),details.clientId,current.id,details.redirectUri,details.challenge,details.requested,details.scope]);
      await db.query(`INSERT INTO audit_events(actor_id,actor_name,scope,action,target_type)
         VALUES($1,$2,'public','chatgpt.authorize','chatgptConnection')`,
        [current.id,current.displayName]);
    });
    const destination=new URL(details.redirectUri);
    destination.searchParams.set("code",code);
    destination.searchParams.set("state",details.state);
    destination.searchParams.set("iss",origin);
    res.redirect(302,destination.href);
  }));
  router.post("/oauth/token",form,handler(async(req,res)=>{
    limit("chatgpt-token:"+req.ip,150);
    res.setHeader("Cache-Control","no-store");
    const input=req.body as Record<string,unknown>;
    const clientId=str(input?.client_id),requested=str(input?.resource);
    if(![origin,resource,alraesyResource].includes(requested))
      throw new HttpError(400,"invalid_target","المورد غير معروف");
    if(!(await pool.query("SELECT 1 FROM chatgpt_oauth_clients WHERE client_id=$1",[clientId])).rowCount)
      throw new HttpError(401,"invalid_client","العميل غير مسجل");
    if(input.grant_type==="authorization_code"){
      const code=str(input.code),verifier=str(input.code_verifier),redirect=str(input.redirect_uri);
      if(!/^[A-Za-z0-9_-]{43}$/.test(code)||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
        throw new HttpError(400,"invalid_grant","رمز OAuth غير صالح");
      const value=await transaction(pool,async(db)=>{
        const row=(await db.query("DELETE FROM chatgpt_oauth_codes WHERE code_hash=$1 RETURNING *",
          [tokenHash(code)])).rows[0];
        if(!row||row.expires_at<new Date()||row.client_id!==clientId||
          row.redirect_uri!==redirect||row.resource!==requested||
          hashPkce(verifier)!==row.code_challenge)
          throw new HttpError(400,"invalid_grant","رمز OAuth غير مطابق أو انتهت صلاحيته");
        const access=token(),refresh=token();
        await db.query(`INSERT INTO chatgpt_oauth_tokens
          (access_hash,refresh_hash,client_id,user_id,resource,scope,access_expires_at,refresh_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '90 days')`,
          [tokenHash(access),tokenHash(refresh),clientId,row.user_id,requested,row.scope]);
        return {access,refresh,scope:row.scope as string};
      });
      res.json({access_token:value.access,refresh_token:value.refresh,token_type:"Bearer",
        expires_in:3600,scope:value.scope});return;
    }
    if(input.grant_type==="refresh_token"){
      const refreshToken=str(input.refresh_token);
      if(!/^[A-Za-z0-9_-]{43}$/.test(refreshToken))
        throw new HttpError(400,"invalid_grant","رمز التجديد غير صالح");
      const value=await transaction(pool,async(db)=>{
        const row=(await db.query("SELECT * FROM chatgpt_oauth_tokens WHERE refresh_hash=$1 FOR UPDATE",
          [tokenHash(refreshToken)])).rows[0];
        if(!row||row.client_id!==clientId||row.resource!==requested||
          row.revoked_at||row.refresh_expires_at<new Date())
          throw new HttpError(400,"invalid_grant","تم إلغاء الاتصال أو انتهت صلاحيته");
        const access=token(),refresh=token();
        await db.query(`UPDATE chatgpt_oauth_tokens SET access_hash=$1,refresh_hash=$2,
           access_expires_at=now()+interval '1 hour' WHERE id=$3`,
          [tokenHash(access),tokenHash(refresh),row.id]);
        return {access,refresh,scope:row.scope as string};
      });
      res.json({access_token:value.access,refresh_token:value.refresh,token_type:"Bearer",
        expires_in:3600,scope:value.scope});return;
    }
    throw new HttpError(400,"unsupported_grant_type","نوع منح الصلاحية غير مدعوم");
  }));
  router.get("/oauth/connections",sessions,handler(async(req,res)=>{
    if(!req.auth)throw new HttpError(401,"unauthenticated","سجّل الدخول");
    const user=await currentActor(pool,req.auth.user,false);
    const records=await pool.query<{id:number;created_at:Date}>(
      "SELECT id,created_at FROM chatgpt_oauth_tokens WHERE user_id=$1 AND revoked_at IS NULL AND refresh_expires_at>now() ORDER BY id DESC LIMIT 100",
      [user.id]);
    const rows=records.rows.map(row=>`<li>اتصال ChatGPT بتاريخ ${safe(row.created_at.toISOString().slice(0,10))}
      <form method="post" action="/oauth/connections/${row.id}/revoke">
      <input type="hidden" name="csrf" value="${safe(req.auth!.csrf)}">
      <button type="submit">إلغاء الاتصال</button></form></li>`).join("");
    res.type("html").send(webPage("اتصالات ChatGPT",`<p>يمكنك إلغاء أي اتصال فورًا.</p>
      <ul>${rows||"<li>لا توجد اتصالات فعالة</li>"}</ul><a href="/">العودة إلى تجارة</a>`));
  }));
  router.post("/oauth/connections/:id/revoke",form,sessions,handler(async(req,res)=>{
    if(!req.auth||req.body?.csrf!==req.auth.csrf)
      throw new HttpError(403,"csrf","العملية غير مصرح بها");
    const user=await currentActor(pool,req.auth.user,false);
    if(!/^[1-9]\d*$/.test(String(req.params.id)))throw new HttpError(400,"invalid_id","رقم غير صالح");
    await transaction(pool,async(db)=>{
      await db.query("UPDATE chatgpt_oauth_tokens SET revoked_at=now() WHERE id=$1 AND user_id=$2",
        [Number(req.params.id),user.id]);
      await db.query(`INSERT INTO audit_events(actor_id,actor_name,scope,action,target_type,target_id)
       VALUES($1,$2,'public','chatgpt.revoke','chatgptConnection',$3)`,
        [user.id,user.displayName,Number(req.params.id)]);
    });
    res.redirect(303,"/oauth/connections");
  }));
  return router;
}
