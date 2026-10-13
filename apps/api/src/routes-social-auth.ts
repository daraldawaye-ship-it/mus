import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import type { KeyObject, JsonWebKey } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import { transaction } from "./db.ts";
import { handler, loadSession, setSessionCookie } from "./http.ts";
import { HttpError } from "./errors.ts";
import { authLimiter, createSession, passwordHash, tokenHash } from "./services/auth.ts";
import { userDTO } from "./repositories/models.ts";
import { audit } from "./services/audit.ts";

type Provider = "google" | "apple";
type Intent = "login" | "link";
type Config = { clientId: string; clientSecret: string; appleTeamId?: string; appleKeyId?: string; applePrivateKey?: string };
type Claims = { sub: string; email: string; emailVerified: boolean; name: string };
const providers: Provider[] = ["google", "apple"];
const issuer: Record<Provider,string[]> = {
  google:["https://accounts.google.com","accounts.google.com"],
  apple:["https://appleid.apple.com"],
};
const urls = {
  google: {authorize:"https://accounts.google.com/o/oauth2/v2/auth",token:"https://oauth2.googleapis.com/token",keys:"https://www.googleapis.com/oauth2/v3/certs"},
  apple: {authorize:"https://appleid.apple.com/auth/authorize",token:"https://appleid.apple.com/auth/token",keys:"https://appleid.apple.com/auth/keys"},
};
const random = () => randomBytes(32).toString("base64url");
const digest = (input:string) => createHash("sha256").update(input).digest("base64url");
const cookieName = (provider:Provider) => `tijara_social_${provider}`;
function oauthConfig(): Record<Provider,Config|null> {
  const googleId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const appleId = process.env.APPLE_CLIENT_ID?.trim() ?? "";
  const appleTeamId = process.env.APPLE_TEAM_ID?.trim() ?? "";
  const appleKeyId = process.env.APPLE_KEY_ID?.trim() ?? "";
  const applePrivateKey = (process.env.APPLE_PRIVATE_KEY ?? "").replaceAll("\\n","\n").trim();
  return {
    google:googleId && googleSecret ? {clientId:googleId,clientSecret:googleSecret} : null,
    apple:appleId && appleTeamId && appleKeyId && applePrivateKey
      ? {clientId:appleId,clientSecret:"",appleTeamId,appleKeyId,applePrivateKey} : null,
  };
}
function cookieSettings(provider: Provider, production:boolean) {
  return {httpOnly:true,secure:production,sameSite:provider==="apple" && production ? "none" as const : "lax" as const,
    path:`/api/auth/social/${provider}/callback`,maxAge:10*60*1000};
}
function redirectUri(origin:string,provider:Provider) {
  return `${origin}/api/auth/social/${provider}/callback`;
}
function encodedJson(input:unknown):string {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}
function appleSecret(config:Config):string {
  const now=Math.floor(Date.now()/1000);
  const data=`${encodedJson({alg:"ES256",kid:config.appleKeyId,typ:"JWT"})}.${encodedJson({
    iss:config.appleTeamId,iat:now,exp:now+300,aud:"https://appleid.apple.com",sub:config.clientId,
  })}`;
  const signature=sign("sha256",Buffer.from(data),{
    key:createPrivateKey(config.applePrivateKey!),dsaEncoding:"ieee-p1363",
  });
  return `${data}.${signature.toString("base64url")}`;
}
type JwkSet = {keys:(JsonWebKey & {kid?:string;use?:string;alg?:string;kty?:string})[]};
const keyCache=new Map<Provider,{until:number;keys:JwkSet["keys"]}>();
async function publicKeys(provider:Provider) {
  const stored=keyCache.get(provider);
  if(stored && stored.until>Date.now()) return stored.keys;
  const response=await fetch(urls[provider].keys,{signal:AbortSignal.timeout(10000)});
  if(!response.ok) throw new HttpError(502,"oidc_keys","تعذر التحقق من مزود تسجيل الدخول");
  const body=await response.json() as JwkSet;
  if(!Array.isArray(body?.keys) || body.keys.length===0)
    throw new HttpError(502,"oidc_keys","تعذر الحصول على مفاتيح التحقق");
  keyCache.set(provider,{until:Date.now()+10*60*1000,keys:body.keys});
  return body.keys;
}
async function verifyIdToken(
  jwt:string,provider:Provider,clientId:string,nonce:string,
):Promise<Claims>{
  if(typeof jwt!=="string"||jwt.length>20000) throw new HttpError(401,"oidc_token","رمز الدخول غير صالح");
  const segments=jwt.split(".");
  if(segments.length!==3 || segments.some(segment=>!segment||segment.length>18000))
    throw new HttpError(401,"oidc_token","رمز الدخول غير صالح");
  let header: {alg?:string;kid?:string;typ?:string};
  let claims:Record<string,unknown>;
  try {
    header=JSON.parse(Buffer.from(segments[0]!,"base64url").toString("utf8"));
    claims=JSON.parse(Buffer.from(segments[1]!,"base64url").toString("utf8"));
  } catch {
    throw new HttpError(401,"oidc_token","رمز الدخول غير صالح");
  }
  if(!header||header.alg!=="RS256"||typeof header.kid!=="string"||header.kid.length>200 ||
      !claims || typeof claims!=="object")
    throw new HttpError(401,"oidc_token","نوع توقيع الدخول غير مقبول");
  const keys=await publicKeys(provider);
  const key=keys.find(k=>k.kid===header.kid && k.kty==="RSA" && (k.use===undefined||k.use==="sig") && (!k.alg||k.alg==="RS256"));
  if(!key) throw new HttpError(401,"oidc_token","مفتاح التحقق غير معروف");
  let publicKey:KeyObject;
  try { publicKey=createPublicKey({key:key as JsonWebKey,format:"jwk"}); }
  catch {throw new HttpError(401,"oidc_token","مفتاح التحقق غير صالح");}
  const valid=verify("RSA-SHA256",Buffer.from(`${segments[0]}.${segments[1]}`),publicKey,Buffer.from(segments[2]!,"base64url"));
  if(!valid) throw new HttpError(401,"oidc_token","توقيع الدخول غير صحيح");
  const now=Math.floor(Date.now()/1000);
  if(!issuer[provider].includes(String(claims.iss)) ||
      claims.aud!==clientId ||
      typeof claims.exp!=="number" || claims.exp<now-60 ||
      typeof claims.iat!=="number" || claims.iat>now+60 ||
      claims.nonce!==nonce ||
      typeof claims.sub!=="string" || !claims.sub || claims.sub.length>255)
    throw new HttpError(401,"oidc_token","بيانات اعتماد مزود الدخول غير صالحة");
  const email=typeof claims.email==="string" && claims.email.length<=254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
    ? claims.email.trim().toLowerCase() : "";
  const emailVerified=claims.email_verified===true || claims.email_verified==="true";
  const name=typeof claims.name==="string"?claims.name.trim().slice(0,120):"";
  return {sub:claims.sub,email,emailVerified,name};
}
async function tokenExchange(
  provider:Provider,config:Config,origin:string,code:string,verifier:string|null,
) {
  const params=new URLSearchParams({
    grant_type:"authorization_code",code,client_id:config.clientId,
    client_secret:provider==="apple"?appleSecret(config):config.clientSecret,
    redirect_uri:redirectUri(origin,provider),
  });
  if(provider==="google" && verifier) params.set("code_verifier",verifier);
  const response=await fetch(urls[provider].token,{
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded","accept":"application/json"},
    body:params.toString(),signal:AbortSignal.timeout(12000),
  });
  if(!response.ok) throw new HttpError(401,"oidc_exchange","تعذر إكمال المصادقة الخارجية");
  const data=await response.json() as {id_token?:unknown};
  if(typeof data.id_token!=="string") throw new HttpError(401,"oidc_token","لم تصل هوية المستخدم من مزود الدخول");
  return data.id_token;
}
function safeReturn(raw:unknown):string {
  if(typeof raw!=="string"||raw.length>450) return "/";
  if(raw==="/")return raw;
  if(raw.startsWith("/oauth/authorize?") && !raw.includes("\\") && !raw.includes("//")) return raw;
  return "/";
}
function errorRedirect(res:Response,code:string,intent:Intent) {
  const page=intent==="link"?"/profile":"/login";
  return res.redirect(303,`${page}?socialError=${encodeURIComponent(code)}`);
}
function providerFrom(value:string):Provider {
  if(value!=="google" && value!=="apple")
    throw new HttpError(404,"social_provider","مزود الدخول غير متاح");
  return value;
}

export function socialAuthRoutes(pool:Pool,origin:string,production:boolean):Router {
  const router=Router();
  const config=oauthConfig(),limit=authLimiter();
  router.get("/auth/social/providers",(_req,res)=>res.json({
    google:Boolean(config.google),apple:Boolean(config.apple),
  }));
  router.get("/auth/social/:provider/start",loadSession(pool),handler(async(req,res)=>{
    const provider=providerFrom(req.params.provider as string);
    const client=config[provider];
    if(!client) throw new HttpError(503,"social_not_configured","لم يُجهَّز الدخول بواسطة هذا المزود بعد");
    limit(`social:start:${req.ip}`,30);
    const intent:Intent=req.query.intent==="link"?"link":"login";
    if(intent==="link" && !req.auth)
      throw new HttpError(401,"unauthenticated","سجّل الدخول أولًا لربط حسابك");
    const state=random(),nonce=random(),verifier=provider==="google"?random():null;
    const returnTo=safeReturn(req.query.returnTo);
    await pool.query("DELETE FROM social_auth_attempts WHERE expires_at<now()");
    await pool.query(
      `INSERT INTO social_auth_attempts(state_hash,provider,nonce,code_verifier,intent,user_id,return_to,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`,
      [tokenHash(state),provider,nonce,verifier,intent,intent==="link"?req.auth!.user.id:null,returnTo],
    );
    const query=new URLSearchParams({
      client_id:client.clientId,response_type:"code",redirect_uri:redirectUri(origin,provider),
      state,nonce,scope:provider==="google"?"openid email profile":"name email",
    });
    if(provider==="apple"){
      query.set("response_mode","form_post");
    } else {
      query.set("code_challenge_method","S256");
      query.set("code_challenge",digest(verifier!));
    }
    res.cookie(cookieName(provider),state,cookieSettings(provider,production));
    res.redirect(302,`${urls[provider].authorize}?${query}`);
  }));
  async function callback(req:Request,res:Response,provider:Provider,input:Record<string,unknown>) {
    const configured=config[provider];
    if(!configured)return errorRedirect(res,"not_configured","login");
    const state=typeof input.state==="string"?input.state:"";
    const code=typeof input.code==="string"?input.code:"";
    const browserState=(req.headers.cookie??"").split(";").map(p=>p.trim())
      .find(p=>p.startsWith(cookieName(provider)+"="))?.slice(cookieName(provider).length+1);
    res.clearCookie(cookieName(provider),{...cookieSettings(provider,production),maxAge:undefined});
    if(!/^[A-Za-z0-9_-]{43}$/.test(state) || state!==browserState)
      return errorRedirect(res,"invalid_state","login");
    const attempt=await transaction(pool,async(db)=>{
      const result=await db.query(
        "DELETE FROM social_auth_attempts WHERE state_hash=$1 AND provider=$2 AND expires_at>now() RETURNING *",
        [tokenHash(state),provider],
      );
      return result.rows[0] as {nonce:string;code_verifier:string|null;intent:Intent;user_id:number|null;return_to:string}|undefined;
    });
    if(!attempt)return errorRedirect(res,"expired_state","login");
    if(typeof input.error==="string") return errorRedirect(res,"cancelled",attempt.intent);
    if(!/^[A-Za-z0-9._~-]{5,4096}$/.test(code))
      return errorRedirect(res,"missing_code",attempt.intent);
    try{
      const idToken=await tokenExchange(provider,configured,origin,code,attempt.code_verifier);
      const identity=await verifyIdToken(idToken,provider,configured.clientId,attempt.nonce);
      // Provider subject is the only durable credential. Never auto-link by email.
      const result=await transaction(pool,async(db:PoolClient)=>{
        const linked=await db.query(
          `SELECT s.user_id,u.* FROM social_identities s JOIN users u ON u.id=s.user_id
           WHERE s.provider=$1 AND s.subject=$2 FOR UPDATE OF s,u`,
          [provider,identity.sub],
        );
        if(attempt.intent==="link"){
          if(!attempt.user_id) throw new HttpError(403,"social_link","ربط الحساب غير مسموح");
          const existing=linked.rows[0];
          if(existing && existing.user_id!==attempt.user_id)
            throw new HttpError(409,"social_taken","هذه الهوية مرتبطة بمستخدم آخر");
          const user=(await db.query(
            "SELECT * FROM users WHERE id=$1 AND NOT archived FOR UPDATE",[attempt.user_id],
          )).rows[0];
          if(!user)throw new HttpError(403,"social_link","الحساب غير نشط");
          await db.query(
            `INSERT INTO social_identities(provider,subject,user_id,email_at_link)
             VALUES($1,$2,$3,$4)
             ON CONFLICT(provider,subject) DO UPDATE SET email_at_link=excluded.email_at_link`,
            [provider,identity.sub,user.id,identity.email],
          );
          await audit(db,userDTO(user),"user.profile","user",user.id,null,null);
          return {linked:true as const,userId:user.id};
        }
        let user=linked.rows[0];
        if(!user){
          if(!identity.emailVerified || !identity.email)
            throw new HttpError(409,"social_email_required","لم يقدّم المزود بريدًا موثّقًا؛ سجّل الدخول بحسابك ثم اربط المزود من الملف الشخصي");
          const collision=await db.query("SELECT 1 FROM users WHERE email=$1 LIMIT 1",[identity.email]);
          if(collision.rowCount)
            throw new HttpError(409,"social_existing_email","هذا البريد مرتبط بحساب قائم؛ سجّل الدخول بالطريقة السابقة ثم اربط Google أو Apple من الملف الشخصي");
          const name=identity.name || identity.email.split("@")[0]!.slice(0,120) || "مستخدم";
          const randomizedPassword=await passwordHash(random());
          const inserted=await db.query(
            `INSERT INTO users(name,display_name,email,phone,password_hash)
             VALUES($1,$1,$2,'',$3) RETURNING *`,[name,identity.email,randomizedPassword],
          );
          user=inserted.rows[0];
          await audit(db,userDTO(user),"user.register","user",user.id,null,userDTO(user));
          await db.query(
            "INSERT INTO social_identities(provider,subject,user_id,email_at_link) VALUES($1,$2,$3,$4)",
            [provider,identity.sub,user.id,identity.email],
          );
        }
        if(user.archived || user.suspended)
          throw new HttpError(403,"social_blocked","هذا الحساب معطّل");
        const account=userDTO(user);
        await audit(db,account,"auth.login","user",account.id,null,null);
        return {linked:false as const,...(await createSession(db,account.id))};
      });
      if(result.linked)return res.redirect(303,"/profile?socialConnected="+provider);
      setSessionCookie(res,result.token,production);
      return res.redirect(303,attempt.return_to);
    }catch(err){
      if(err instanceof HttpError)return errorRedirect(res,err.code,attempt.intent);
      if((err as {code?:string}).code==="23505")return errorRedirect(res,"social_conflict",attempt.intent);
      console.error("Social sign-in failed",err instanceof Error?err.name:"unknown");
      return errorRedirect(res,"social_unavailable",attempt.intent);
    }
  }
  router.get("/auth/social/google/callback",handler(async(req,res)=>{
    await callback(req,res,"google",req.query as Record<string,unknown>);
  }));
  // Apple's requested name/email scopes require cross-site form_post. This
  // endpoint is *before* the JSON API Origin gate and is protected by one-time
  // state + HttpOnly browser-bound SameSite=None cookie and signed ID token.
  router.post("/auth/social/apple/callback",urlencoded({extended:false,limit:"16kb"}),handler(async(req,res)=>{
    await callback(req,res,"apple",req.body as Record<string,unknown>);
  }));
  return router;
}
