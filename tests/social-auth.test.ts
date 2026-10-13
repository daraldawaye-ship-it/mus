import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { Server } from "node:http";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { SessionResponse } from "../packages/contracts/src/index.ts";

const databaseUrl=process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin="http://localhost";
const password="Social-test-passphrase-2026";

class Browser {
  private cookies=new Map<string,string>();
  private csrf="";
  constructor(private readonly base:string){}
  async send(method:string,path:string,body?:unknown,contentType="application/json"){
    const headers=new Headers({cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join("; "),accept:"application/json"});
    if(method!=="GET"){
      headers.set("content-type",contentType);
      headers.set("origin",origin);
      if(this.csrf)headers.set("x-csrf-token",this.csrf);
    }
    const response=await fetch(this.base+path,{
      method,headers,redirect:"manual",
      body:body===undefined?undefined:contentType==="application/x-www-form-urlencoded"
        ?String(body):JSON.stringify(body),
    });
    for(const cookie of response.headers.getSetCookie()){
      const entry=cookie.split(";",1)[0]!;
      const index=entry.indexOf("="),name=entry.slice(0,index),value=entry.slice(index+1);
      if(/max-age=0/i.test(cookie))this.cookies.delete(name);
      else this.cookies.set(name,value);
    }
    const raw=await response.text();
    let parsed:unknown;
    try{parsed=JSON.parse(raw);}catch{parsed=raw;}
    if(parsed&&typeof parsed==="object"&&"csrf" in parsed){
      const csrf=(parsed as SessionResponse).csrf;
      if(typeof csrf==="string")this.csrf=csrf;
    }
    return {response,body:parsed as any};
  }
  async ok(method:string,path:string,body?:unknown,expected=200){
    const r=await this.send(method,path,body);
    assert.equal(r.response.status,expected,JSON.stringify(r.body));
    return r.body;
  }
}

test("Google and Apple OIDC flows verify state, nonce and signed provider subject, refuse email auto-link and support explicit linking",async t=>{
  const rsa=generateKeyPairSync("rsa",{modulusLength:2048});
  const ec=generateKeyPairSync("ec",{namedCurve:"P-256"});
  const keys=rsa.publicKey.export({format:"jwk"});
  const nonceByCode=new Map<string,{provider:"google"|"apple";nonce:string;email:string;name:string;sub:string}>();
  const oldEnv=Object.fromEntries(
    ["GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","APPLE_CLIENT_ID","APPLE_TEAM_ID","APPLE_KEY_ID","APPLE_PRIVATE_KEY"]
      .map(k=>[k,process.env[k]]),
  );
  const originalFetch=globalThis.fetch;
  process.env.GOOGLE_CLIENT_ID="google-test-client";
  process.env.GOOGLE_CLIENT_SECRET="google-test-secret";
  process.env.APPLE_CLIENT_ID="apple.test.service";
  process.env.APPLE_TEAM_ID="TEAM123456";
  process.env.APPLE_KEY_ID="APPLEKEY42";
  process.env.APPLE_PRIVATE_KEY=ec.privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const schema="social_test_"+randomUUID().replaceAll("-","");
  const codeTokens=new Map<string,string>();
  function jwtFor(code:string) {
    const info=nonceByCode.get(code);
    assert(info,"unknown exchange code");
    const now=Math.floor(Date.now()/1000);
    const header=Buffer.from(JSON.stringify({alg:"RS256",kid:"TEST_KEY"})).toString("base64url");
    const claims=Buffer.from(JSON.stringify({
      iss:info.provider==="google"?"https://accounts.google.com":"https://appleid.apple.com",
      aud:info.provider==="google"?"google-test-client":"apple.test.service",
      sub:info.sub,email:info.email,email_verified:true,name:info.name,
      nonce:info.nonce,iat:now,exp:now+120,
    })).toString("base64url");
    const text=header+"."+claims;
    return text+"."+sign("RSA-SHA256",Buffer.from(text),rsa.privateKey).toString("base64url");
  }
  globalThis.fetch=((input:RequestInfo|URL,init?:RequestInit)=>{
    const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
    if(url==="https://www.googleapis.com/oauth2/v3/certs"||url==="https://appleid.apple.com/auth/keys")
      return Promise.resolve(new Response(JSON.stringify({keys:[{...keys,kid:"TEST_KEY",use:"sig",alg:"RS256"}]}),{
        status:200,headers:{"content-type":"application/json"},
      }));
    if(url==="https://oauth2.googleapis.com/token"||url==="https://appleid.apple.com/auth/token"){
      const code=new URLSearchParams(String(init?.body)).get("code")??"";
      const info=nonceByCode.get(code);
      if(!info)return Promise.resolve(new Response("invalid",{status:401}));
      const token=jwtFor(code);
      codeTokens.set(code,token);
      return Promise.resolve(new Response(JSON.stringify({id_token:token}),{
        status:200,headers:{"content-type":"application/json"},
      }));
    }
    return originalFetch(input,init);
  }) as typeof fetch;
  let rt:Awaited<ReturnType<typeof createApp>>|undefined;
  let server:Server|undefined;
  t.after(async()=>{
    if(server)await new Promise<void>((resolve,reject)=>server!.close(err=>err?reject(err):resolve()));
    if(rt)await rt.close();
    const db=new Pool({connectionString:databaseUrl});
    try{await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}
    finally{await db.end();}
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(oldEnv)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  });
  rt=await createApp({databaseUrl,schema,appOrigin:origin,production:false,serveStatic:false});
  server=rt.app.listen(0,"127.0.0.1");
  await new Promise<void>((resolve,reject)=>{server!.once("listening",resolve);server!.once("error",reject);});
  const address=server.address();assert(address&&typeof address!=="string");
  const base=`http://127.0.0.1:${address.port}`;
  const browser=new Browser(base);
  const status=await browser.ok("GET","/api/auth/social/providers");
  assert.deepEqual(status,{google:true,apple:true});
  let number=0;
  async function authorize(
    browser:Browser,provider:"google"|"apple",spec:{email:string;sub:string;name?:string},intent:"login"|"link"="login",
  ) {
    const code=`test-code-${++number}`;
    const start=await browser.send("GET",`/api/auth/social/${provider}/start?intent=${intent}`);
    assert.equal(start.response.status,302,JSON.stringify(start.body));
    const location=new URL(start.response.headers.get("location")!);
    assert.equal(location.origin,provider==="google"?"https://accounts.google.com":"https://appleid.apple.com");
    assert.equal(location.searchParams.get("response_type"),"code");
    assert.equal(location.searchParams.get("client_id"),provider==="google"?"google-test-client":"apple.test.service");
    if(provider==="google")assert.equal(location.searchParams.get("code_challenge_method"),"S256");
    else assert.equal(location.searchParams.get("response_mode"),"form_post");
    const nonce=location.searchParams.get("nonce")!;
    const state=location.searchParams.get("state")!;
    nonceByCode.set(code,{provider,nonce,email:spec.email,name:spec.name??"Social user",sub:spec.sub});
    const callback=`/api/auth/social/${provider}/callback`;
    return {state,code,callback};
  }
  async function complete(browser:Browser,provider:"google"|"apple",params:{state:string;code:string;callback:string}){
    if(provider==="google")
      return browser.send("GET",`${params.callback}?state=${params.state}&code=${params.code}`);
    return browser.send("POST",params.callback,
      new URLSearchParams({state:params.state,code:params.code}).toString(),"application/x-www-form-urlencoded");
  }
  const missing=await browser.send("GET","/api/auth/social/google/callback?state=wrong&code=forged");
  assert.equal(missing.response.status,303);
  assert.match(missing.response.headers.get("location")??"",/invalid_state/);
  const first=await authorize(browser,"google",{email:"google-first@social.test",sub:"google-sub-101"});
  const completed=await complete(browser,"google",first);
  assert.equal(completed.response.status,303,JSON.stringify(completed.body));
  assert.equal(completed.response.headers.get("location"),"/");
  const current=await browser.ok("GET","/api/auth/session") as SessionResponse;
  assert.equal(current.user?.email,"google-first@social.test");
  assert.equal(current.user?.phone,"");
  assert.equal((await rt.pool.query("SELECT count(*)::int AS n FROM social_identities")).rows[0].n,1);
  const again=await authorize(browser,"google",{email:"google-first@social.test",sub:"google-sub-101"});
  assert.equal((await complete(browser,"google",again)).response.status,303);
  assert.equal((await (browser.ok("GET","/api/auth/session") as Promise<SessionResponse>)).user?.id,current.user!.id);
  // Never silently join an existing email-based account, even with verified email.
  const owner=await provisionOwner(rt.pool,{
    name:"Test Owner",displayName:"Owner",email:"owner@example.social",password,
  });
  const other=new Browser(base);
  await other.ok("POST","/api/auth/login",{email:owner.email,password});
  const conflict=await authorize(new Browser(base),"google",{email:"owner@example.social",sub:"new-google-sub"});
  // Keep the same anonymous browser for cookie-bound callback.
  const anon=new Browser(base);
  const clash=await authorize(anon,"google",{email:"owner@example.social",sub:"new-google-sub"});
  const denied=await complete(anon,"google",clash);
  assert.equal(denied.response.status,303);
  assert.match(denied.response.headers.get("location")??"",/social_existing_email/);
  assert.equal((await (anon.ok("GET","/api/auth/session") as Promise<SessionResponse>)).user,null);
  // The account owner can explicitly link this Google subject after login.
  const link=await authorize(other,"google",{email:"owner@example.social",sub:"new-google-sub"},"link");
  const linked=await complete(other,"google",link);
  assert.equal(linked.response.status,303);
  assert.match(linked.response.headers.get("location")??"",/socialConnected=google/);
  await other.ok("POST","/api/auth/logout");
  const socialLogin=await authorize(other,"google",{email:"owner@example.social",sub:"new-google-sub"});
  assert.equal((await complete(other,"google",socialLogin)).response.status,303);
  assert.equal((await (other.ok("GET","/api/auth/session") as Promise<SessionResponse>)).user?.id,owner.id);
  const appleUser=new Browser(base);
  const apple=await authorize(appleUser,"apple",{email:"private-relay@privaterelay.appleid.com",sub:"apple-sub-1",name:"Apple Tester"});
  const appleComplete=await complete(appleUser,"apple",apple);
  assert.equal(appleComplete.response.status,303);
  assert.equal((await (appleUser.ok("GET","/api/auth/session") as Promise<SessionResponse>)).user?.email,
    "private-relay@privaterelay.appleid.com");
  // Replay must be rejected after state was consumed and cookie cleared.
  const replay=await complete(appleUser,"apple",apple);
  assert.equal(replay.response.status,303);
  assert.match(replay.response.headers.get("location")??"",/invalid_state|expired_state/);
  assert.equal(codeTokens.size>=3,true);
});
