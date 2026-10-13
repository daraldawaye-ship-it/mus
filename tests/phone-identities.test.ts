import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { Company, SessionResponse, Employee } from "../packages/contracts/src/index.ts";

const password = "Phone-first-integration-test-passphrase";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";

class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private url: string) {}
  async request<T>(method: string, path: string, body?: unknown) {
    const h = new Headers({accept:"application/json"});
    if (this.cookie) h.set("cookie",this.cookie);
    if (method !== "GET") {
      h.set("content-type","application/json");h.set("origin",origin);
      if (this.csrf) h.set("x-csrf-token",this.csrf);
    }
    const response=await fetch(this.url+"/api"+path,{
      method,headers:h,body:body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of response.headers.getSetCookie())
      this.cookie=/max-age=0/i.test(c)?"":c.split(";",1)[0]!;
    const data=(await response.json()) as T;
    if(data && typeof data==="object" && "csrf" in data)
      this.csrf=(data as unknown as SessionResponse).csrf;
    return {status:response.status,body:data};
  }
  async ok<T>(method:string,path:string,body?:unknown,status=200){
    const r=await this.request<T>(method,path,body);
    assert.equal(r.status,status,JSON.stringify(r.body));
    return r.body;
  }
}
test("owner provisions login by phone and password, keeps email optional and resets without storing raw secrets", async t=>{
  const schema="phone_first_"+randomUUID().replaceAll("-","");
  const rt=await createApp({databaseUrl,schema,appOrigin:origin,production:false,serveStatic:false});
  const server:Server=rt.app.listen(0,"127.0.0.1");
  await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
  const address=server.address();assert(address && typeof address!=="string");
  const url=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await rt.close();
    const clean=new Pool({connectionString:databaseUrl});
    try {await clean.query(`DROP SCHEMA "${schema}" CASCADE`);}
    finally {await clean.end();}
  });
  const root=await provisionOwner(rt.pool,{
    name:"Owner",displayName:"Owner",email:"owner@phone.test",password,
  });
  const owner=new Client(url);await owner.ok("POST","/auth/login",{email:root.email,password});
  const co=(await owner.ok<{company:Company}>("POST","/companies",{name:"Phone test",phone:"",address:""},201)).company;
  const newSecret="First-employee-password-2026";
  const added=await owner.ok<{employee:Employee;accounts:unknown[]}>(
    "POST",`/companies/${co.id}/employees`,{
      newUser:{name:"فاطمة",phone:"٠٧٧٧ ١٢٣-٤٥٦٧",email:"",password:newSecret},
      name:"فاطمة",phone:"٠٧٧٧ ١٢٣-٤٥٦٧",role:"sales",permissions:[],createSalesCashbox:true,
    },201,
  );
  assert.equal(added.employee.name,"فاطمة");
  assert.equal(added.accounts.length,3);
  const profile=await rt.pool.query<{
    phone:string;phone_login_key:string;phone_verified_at:Date|null;email:string;password_hash:string
  }>("SELECT phone,phone_login_key,phone_verified_at,email,password_hash FROM users WHERE id=$1",[added.employee.userId]);
  assert.equal(profile.rows[0]?.phone,"07771234567");
  assert.equal(profile.rows[0]?.phone_login_key,"07771234567");
  assert.equal(profile.rows[0]?.phone_verified_at,null);
  assert.equal(profile.rows[0]?.email,"");
  assert.notEqual(profile.rows[0]?.password_hash,newSecret);
  assert.ok(profile.rows[0]!.password_hash.startsWith("scrypt:"));
  const userLogin=new Client(url);
  const session=await userLogin.ok<SessionResponse>("POST","/auth/login",{
    phone:"٠٧٧٧ ١٢٣-٤٥٦٧",password:newSecret,
  });
  assert.equal(session.user?.id,added.employee.userId);
  assert.equal((await userLogin.ok<SessionResponse>("GET","/auth/session")).user?.id,added.employee.userId);
  const second=new Client(url);
  await second.ok<SessionResponse>("POST","/auth/register",{
    name:"Another",displayName:"Another",email:"",
    phone:"07772222222",password,
  },201);
  const emailLegacy=new Client(url);
  await emailLegacy.ok<SessionResponse>("POST","/auth/register",{
    name:"Email fallback",email:"legacy-phone@example.test",phone:"",
    displayName:"Email fallback",password,
  },201);
  const emailLogin=new Client(url);
  assert.equal((await emailLogin.ok<SessionResponse>("POST","/auth/login",{
    email:"legacy-phone@example.test",password,
  })).user?.email,"legacy-phone@example.test");
  assert.equal((await owner.request("POST",`/companies/${co.id}/employees`,{
    newUser:{name:"Conflict",phone:"07771234567",password},
    name:"Conflict",phone:"07771234567",role:"sales",permissions:[],
  })).status,409);
  const unauthorized=await userLogin.request("POST",`/users/${added.employee.userId}/password`,{
    newPassword:"Non-owner-new-password-2026",
  });
  assert.equal(unauthorized.status,403);
  const replacement="New-password-from-owner-2026";
  await owner.ok("POST",`/users/${added.employee.userId}/password`,{newPassword:replacement});
  assert.equal((await userLogin.ok<SessionResponse>("GET","/auth/session")).user,null);
  assert.equal((await userLogin.request("POST","/auth/login",{
    phone:"07771234567",password:newSecret,
  })).status,401);
  assert.equal((await userLogin.ok<SessionResponse>("POST","/auth/login",{
    phone:"07771234567",password:replacement,
  })).user?.id,added.employee.userId);
  assert.equal((await owner.request("POST",`/users/${root.id}/password`,{
    newPassword:replacement,
  })).status,403);
  const authHistory=await rt.pool.query<{action:string;before_value:unknown;after_value:unknown}>(
    "SELECT action,before_value,after_value FROM audit_events WHERE target_type='user' AND target_id=$1 ORDER BY id",
    [added.employee.userId],
  );
  assert(!JSON.stringify(authHistory.rows).includes(newSecret));
  assert(!JSON.stringify(authHistory.rows).includes(replacement));
});
