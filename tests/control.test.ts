import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { assertEditableDocumentDate, assertMobileInvoiceCreation, assertYerWhenCurrencyHidden } from "../apps/api/src/services/control-values.ts";
import type { Company, Employee, SessionResponse } from "../packages/contracts/src/index.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "control-test-password-12345";
class Client {
  cookie = "";
  csrf: string | null = null;
  constructor(private base: string) {}
  async request<T>(method: string, path: string, body?: unknown) {
    const headers = new Headers({accept: "application/json"});
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET") {
      headers.set("origin", origin);
      headers.set("content-type", "application/json");
      if (this.csrf) headers.set("x-csrf-token", this.csrf);
    }
    const response = await fetch(this.base + "/api" + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie())
      this.cookie = /max-age=0/i.test(value) ? "" : value.split(";",1)[0]!;
    const parsed = await response.json() as T;
    if (parsed && typeof parsed === "object" && "csrf" in parsed)
      this.csrf = (parsed as {csrf:string|null}).csrf;
    return {status:response.status, body:parsed};
  }
  async ok<T>(method:string,path:string,body?:unknown,status=200):Promise<T> {
    const reply = await this.request<T>(method,path,body);
    assert.equal(reply.status,status,`${method} ${path} ${JSON.stringify(reply.body)}`);
    return reply.body;
  }
}
type Option = {
  key:string; value:boolean|number; revision:number|null; canEdit:boolean;
  policy:{accountantAllowed:boolean;employeeIds:number[];revision:number|null}|null
};
type Directory = {employeeId:number|null;owner:boolean;options:Option[]};
const option = (directory:Directory,key:string) => {
  const entry=directory.options.find(row=>row.key===key);
  assert(entry,`missing ${key}`);
  return entry;
};
test("control center isolates companies/employees, audits optimistic writes and enforces owner grants",async t=>{
  const schema = `control_test_${randomUUID().replaceAll("-","")}`;
  const runtime = await createApp({databaseUrl,schema,appOrigin:origin,production:false,serveStatic:false});
  const server:Server = runtime.app.listen(0,"127.0.0.1");
  await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject)});
  const address=server.address();
  assert(address && typeof address!=="string");
  const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{
    await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
    await runtime.close();
    const pool=new Pool({connectionString:databaseUrl});
    try{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)}finally{await pool.end()}
  });
  const owner=new Client(base);
  const u=await provisionOwner(runtime.pool,{name:"Control owner",displayName:"Control owner",
    email:"control-owner@example.test",password});
  await owner.ok("POST","/auth/login",{email:u.email,password});
  const first=(await owner.ok<{company:Company}>("POST","/companies",{name:"Alpha",phone:"",address:""},201)).company;
  const second=(await owner.ok<{company:Company}>("POST","/companies",{name:"Beta",phone:"",address:""},201)).company;
  const prefix=`/companies/${first.id}/control`;
  async function staff(role:"accountant"|"sales") {
    const client=new Client(base);
    const user=await client.ok<SessionResponse>("POST","/auth/register",
      {name:role,displayName:role,email:`${randomUUID()}@example.test`,phone:"",password},201);
    assert(user.user);
    const employee=(await owner.ok<{employee:Employee}>("POST",`/companies/${first.id}/employees`,
      {userId:user.user.id,name:role,phone:"",role,active:true,permissions:[]},201)).employee;
    return {client,employee};
  }
  const accountant=await staff("accountant");
  const salesperson=await staff("sales");
  const empty=await owner.ok<Directory>("GET",prefix);
  assert.equal(option(empty,"show_currency").value,true);
  assert.equal(option(empty,"auto_checkout_hours").value,16);
  assert.equal(option(empty,"sales_doctor_threshold").value,1000);
  assert.equal(option(empty,"idle_logout_hours").value,0);
  assert.equal(option(empty,"show_currency").revision,null);
  const purchaseOptionsKey = "show_recent_item_purchases";
  const salesOptionsKey = "show_item_options_sales";
  assert.equal(option(empty, purchaseOptionsKey).value, true);
  assert.equal(option(empty, salesOptionsKey).value, true);

  const write=await owner.ok<{revision:number}>("PUT",prefix+"/show_currency",
    {value:false,employeeId:null,revision:null});
  assert.equal(write.revision,1);
  assert.equal((await owner.request("PUT",prefix+"/show_currency",
    {value:true,employeeId:null,revision:null})).status,409);
  assert.equal(option(await owner.ok<Directory>("GET",prefix),"show_currency").value,false);
  assert.equal(option(await owner.ok<Directory>("GET",`/companies/${second.id}/control`),"show_currency").value,true);

  const accountantView=await accountant.client.ok<Directory>("GET",prefix);
  assert.equal(option(accountantView,"show_currency").canEdit,true);
  assert.equal(option(accountantView,"mobile_sales").canEdit,false);
  assert.equal((await accountant.client.request("PUT",prefix+"/mobile_sales",
    {value:false,employeeId:null,revision:null})).status,403);
  await accountant.client.ok("PUT",prefix+"/show_currency",{value:true,employeeId:null,revision:1});
  assert.equal((await accountant.client.request("PUT",prefix+"/show_currency/policy",
    {accountantAllowed:false,employeeIds:[],revision:null})).status,403);

  const staffView=await salesperson.client.ok<Directory>("GET",prefix);
  assert.equal(option(staffView,"idle_logout_hours").canEdit,false);
  assert.equal((await salesperson.client.request("PUT",prefix+"/idle_logout_hours",
    {value:2,employeeId:salesperson.employee.id,revision:null})).status,403);
  const allowed=await owner.ok<{revision:number}>("PUT",prefix+"/idle_logout_hours/policy",
    {accountantAllowed:false,employeeIds:[salesperson.employee.id],revision:null});
  assert.equal(allowed.revision,1);
  const visible=await salesperson.client.ok<Directory>("GET",prefix);
  assert.equal(option(visible,"idle_logout_hours").canEdit,true);
  await salesperson.client.ok("PUT",prefix+"/idle_logout_hours",
    {value:2,employeeId:salesperson.employee.id,revision:null});
  assert.equal(option(await salesperson.client.ok<Directory>("GET",prefix),"idle_logout_hours").value,2);
  assert.equal(option(await owner.ok<Directory>("GET",prefix+`?employeeId=${salesperson.employee.id}`),"idle_logout_hours").value,2);
  assert.equal((await salesperson.client.request("GET",prefix+`?employeeId=${accountant.employee.id}`)).status,403);
  assert.equal((await owner.request("PUT",prefix+"/idle_logout_hours",
    {value:90,employeeId:salesperson.employee.id,revision:1})).status,400);
  const log=await runtime.pool.query("SELECT action,before_value,after_value FROM audit_events WHERE company_id=$1 AND action LIKE 'control.%' ORDER BY id",[first.id]);
  assert.equal(log.rows.length,4);
  assert.equal(log.rows[0].action,"control.value");
  assert.equal(log.rows[0].after_value.value,false);

  // Purchase and sales item options are independently scoped per employee and company.
  await owner.ok("PUT",prefix+"/"+purchaseOptionsKey,
    {value:false,employeeId:salesperson.employee.id,revision:null});
  const oneDisabled=await owner.ok<Directory>("GET",prefix+`?employeeId=${salesperson.employee.id}`);
  assert.equal(option(oneDisabled,purchaseOptionsKey).value,false);
  assert.equal(option(oneDisabled,salesOptionsKey).value,true);
  assert.equal(option(await owner.ok<Directory>("GET",prefix+`?employeeId=${accountant.employee.id}`),purchaseOptionsKey).value,true);
  assert.equal(option(await owner.ok<Directory>("GET",`/companies/${second.id}/control`),purchaseOptionsKey).value,true);
  assert.equal((await owner.request("PUT",prefix+"/"+salesOptionsKey,
    {value:false,employeeId:null,revision:null})).status,400);
  await owner.ok("PUT",prefix+"/"+salesOptionsKey,
    {value:false,employeeId:salesperson.employee.id,revision:null});
  const bothDisabled=await owner.ok<Directory>("GET",prefix+`?employeeId=${salesperson.employee.id}`);
  assert.equal(option(bothDisabled,purchaseOptionsKey).value,false);
  assert.equal(option(bothDisabled,salesOptionsKey).value,false);

  // Policies must protect API operations even when the form is bypassed.
  await owner.ok("PUT",prefix+"/edit_sales_date",
    {value:false,employeeId:null,revision:null});
  await assert.rejects(
    () => assertEditableDocumentDate(runtime.pool, first.id, "edit_sales_date", "2020-01-01"),
    (error: unknown) => (error as {status:number;code:string}).status === 403,
  );
  await owner.ok("PUT",prefix+"/mobile_sales",
    {value:false,employeeId:null,revision:null});
  await assert.rejects(
    () => assertMobileInvoiceCreation(runtime.pool, first.id, "sale", "Mozilla/5.0 (iPhone)"),
    (error: unknown) => (error as {code:string}).code === "control_mobile_disabled",
  );
  await assertMobileInvoiceCreation(runtime.pool, first.id, "purchase", "Mozilla/5.0 (iPhone)");
  await owner.ok("PUT",prefix+"/show_currency",
    {value:false,employeeId:null,revision:2});
  const currencyRows = await runtime.pool.query(
    "SELECT id,code FROM company_currencies WHERE company_id=$1 AND code IN ('YER','SAR')",
    [first.id],
  );
  const yer = currencyRows.rows.find(row => row.code === "YER")?.id;
  const sar = currencyRows.rows.find(row => row.code === "SAR")?.id;
  assert(yer && sar);
  await assertYerWhenCurrencyHidden(runtime.pool, first.id, yer);
  await assert.rejects(
    () => assertYerWhenCurrencyHidden(runtime.pool, first.id, sar),
    (error: unknown) => (error as {code:string}).code === "control_currency_hidden",
  );
});
