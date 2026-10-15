import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner, createSession } from "../apps/api/src/services/auth.ts";

test("browser OAuth consent explains site-wide actions and issues only the approved grant", async () => {
  const schema="mcp_browser_"+randomUUID().replaceAll("-","");
  const databaseUrl=process.env.DATABASE_URL??DEFAULT_DATABASE_URL;
  const runtime=await createApp({databaseUrl,schema,appOrigin:"http://localhost",serveStatic:false});
  const server=runtime.app.listen(0,"127.0.0.1");
  await once(server,"listening");
  const addr=server.address();assert(addr&&typeof addr!=="string");
  const base=`http://127.0.0.1:${addr.port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:["--no-sandbox"]});
  try {
    const user=await provisionOwner(runtime.pool,{name:"Owner",displayName:"Owner",email:"owner@example.test",password:"Browser-test-password-2026"});
    const session=await createSession(runtime.pool,user.id);
    const context=await browser.newContext();
    await context.addCookies([{name:"tijara_session",value:session.token,url:base}]);
    const page=await context.newPage();
    const registration=await fetch(base+"/oauth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({redirect_uris:["http://localhost:4322/callback"]})});
    const client=await registration.json() as {client_id:string};
    const verifier="v".repeat(64),scope="general_table.read general_table.write tijara.read tijara.write";
    const fields={client_id:client.client_id,redirect_uri:"http://localhost:4322/callback",response_type:"code",scope,state:"browser_state_123456",resource:"http://localhost/mcp",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"};
    await page.goto(base+"/oauth/authorize?"+new URLSearchParams(fields));
    assert.match(await page.locator("main").innerText(),/الموظفين.*الفواتير.*الترحيل/);
    assert.equal(await page.locator("html").getAttribute("dir"),"rtl");
    assert.equal((await runtime.pool.query("SELECT count(*)::int AS n FROM chatgpt_oauth_codes")).rows[0].n,0);
    const redirected=new Promise<string>(resolve=>page.route("http://localhost:4322/callback**",route=>{resolve(route.request().url());return route.fulfill({status:200,body:"Approved"});}));
    await page.getByRole("button",{name:"أوافق على القراءة والإنشاء والتعديل وتنفيذ العمليات",exact:true}).click();
    const callback=new URL(await redirected);
    assert(callback.searchParams.get("code"));assert.equal(callback.searchParams.get("state"),fields.state);
    const code=(await runtime.pool.query("SELECT scope FROM chatgpt_oauth_codes")).rows[0];
    assert.equal(code.scope,scope);
    await context.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await runtime.close();
    const cleanup=new Pool({connectionString:databaseUrl});
    try {await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);} finally {await cleanup.end();}
  }
});
