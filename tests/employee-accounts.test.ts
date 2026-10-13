import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { Company, Employee, SessionResponse } from "../packages/contracts/src/index.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "Employee-account-test-2026-passphrase";

class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private readonly url: string) {}
  async request<T>(method: string, path: string, body?: unknown) {
    const headers = new Headers({accept:"application/json"});
    if(this.cookie) headers.set("cookie",this.cookie);
    if(method !== "GET") {
      headers.set("content-type","application/json");
      headers.set("origin",origin);
      if(this.csrf) headers.set("x-csrf-token",this.csrf);
    }
    const r = await fetch(this.url + "/api" + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for(const cookie of r.headers.getSetCookie())
      this.cookie = /max-age=0/i.test(cookie) ? "" : cookie.split(";",1)[0]!;
    const result = (await r.json()) as T;
    if(result && typeof result === "object" && "csrf" in result)
      this.csrf = (result as unknown as SessionResponse).csrf;
    return {status:r.status,body:result};
  }
  async ok<T>(method:string,path:string,body?:unknown,expected=200):Promise<T>{
    const result=await this.request<T>(method,path,body);
    assert.equal(result.status,expected,
      `${method} ${path}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
}

test("new employees receive a mandatory advance plus optional, scoped sales cashbox and pouch accounts", async t=>{
  const schema="employee_accounts_"+randomUUID().replaceAll("-","");
  const runtime=await createApp({
    databaseUrl,schema,appOrigin:origin,production:false,serveStatic:false,
  });
  const server:Server=runtime.app.listen(0,"127.0.0.1");
  await new Promise<void>((resolve,reject)=>{
    server.once("listening",resolve);server.once("error",reject);
  });
  const address=server.address();
  assert(address && typeof address !== "string");
  const baseUrl=`http://127.0.0.1:${address.port}`;
  t.after(async ()=>{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await runtime.close();
    const cleanup=new Pool({connectionString:databaseUrl});
    try{await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);}
    finally{await cleanup.end();}
  });
  const owner=await provisionOwner(runtime.pool,{
    name:"Accounts owner",displayName:"Accounts owner",
    email:"owner@employee-accounts.test",password,
  });
  const admin=new Client(baseUrl);
  await admin.ok("POST","/auth/login",{email:owner.email,password});
  async function company(name:string){
    return (await admin.ok<{company:Company}>("POST","/companies",{name,phone:"",address:""},201)).company;
  }
  let index=0;
  async function identity(){
    const client=new Client(baseUrl);
    const email=`cashier-${++index}@employee-accounts.test`;
    const registration=await client.ok<SessionResponse>(
      "POST","/auth/register",
      {name:"New Employee",displayName:"New Employee",email,phone:"",password},201,
    );
    assert(registration.user);
    return {id:registration.user.id,client};
  }
  type Created = {employee:Employee;accounts:{
    kind:string;accountId:number;code:string;name:string;
  }[]};
  async function create(companyId:number,userId:number,name:string,cashbox?:boolean) {
    return admin.ok<Created>("POST",`/companies/${companyId}/employees`,{
      userId,name,phone:"",role:"sales",active:true,permissions:[],
      ...(cashbox === undefined ? {} : {createSalesCashbox:cashbox}),
    },201);
  }
  const first=await company("Sales outlets");
  const second=await company("Other tenant");
  const id1=await identity();
  const id2=await identity();
  const id3=await identity();
  const id4=await identity();
  const firstEmployee=await create(first.id,id1.id,"أحمد",true);
  const secondEmployee=await create(first.id,id2.id,"سارة",false);
  const thirdEmployee=await create(first.id,id3.id,"محمد",true);
  const outside=await create(second.id,id4.id,"أحمد",true);
  const simplify=(employee:Created)=>Object.fromEntries(employee.accounts.map(a=>[a.kind,a.code]));
  assert.deepEqual(simplify(firstEmployee),{
    advance:"1140000001",sales_cash:"1111000001",sales_pouch:"1113000001",
  });
  assert.deepEqual(simplify(secondEmployee),{advance:"1140000002"});
  assert.deepEqual(simplify(thirdEmployee),{
    advance:"1140000003",sales_cash:"1111000002",sales_pouch:"1113000002",
  });
  assert.deepEqual(simplify(outside),{
    advance:"1140000001",sales_cash:"1111000001",sales_pouch:"1113000001",
  });
  assert.equal(firstEmployee.accounts.find(a=>a.kind==="sales_cash")?.name,"صندوق مبيعات أحمد");
  assert.equal(firstEmployee.accounts.find(a=>a.kind==="sales_pouch")?.name,"حافظة مبيعات أحمد");
  assert.equal(firstEmployee.accounts.find(a=>a.kind==="advance")?.name,"سلفة أحمد");
  // Each newly provisioned advance is the default financial destination of
  // wallet redemptions, without spending points or posting a journal.
  const bindings = await runtime.pool.query<{
    company_id:number;employee_id:number;account_id:number;revision:number;
  }>(
    `SELECT company_id,employee_id,account_id,revision FROM employee_wallet_accounts
     WHERE company_id=ANY($1::int[]) ORDER BY company_id,employee_id`,
    [[first.id,second.id]],
  );
  assert.equal(bindings.rowCount, 4);
  for (const record of [firstEmployee,secondEmployee,thirdEmployee,outside]) {
    const companyId=record===outside?second.id:first.id;
    const binding=bindings.rows.find(b=>b.company_id===companyId &&
      b.employee_id===record.employee.id);
    assert.equal(binding?.account_id,
      record.accounts.find(a=>a.kind==="advance")?.accountId);
    assert.equal(binding?.revision,1);
  }
  assert.equal((await runtime.pool.query(
    "SELECT count(*)::int AS n FROM financial_documents WHERE company_id=$1",
    [first.id],
  )).rows[0].n,0);

  const result=await runtime.pool.query<{
    employee_id:number;account_kind:string;name:string;code:string;
    parent_code:string;cash_or_bank:boolean;category:string;kind:string;
  }>(`SELECT l.employee_id,l.account_kind,a.name,a.code,
     p.code AS parent_code,a.cash_or_bank,a.category,a.kind
     FROM employee_account_links l
     JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
     JOIN accounts p ON p.company_id=a.company_id AND p.id=a.parent_id
     WHERE l.company_id=$1
     ORDER BY l.employee_id,l.account_kind`,[first.id]);
  assert.equal(result.rows.length,7);
  for(const link of result.rows){
    assert.equal(link.category,"asset");
    assert.equal(link.kind,"posting");
    assert.equal(link.parent_code,link.account_kind==="advance"?"1140000000":
      link.account_kind==="sales_pouch"?"1113000000":"1111000000");
    assert.equal(link.cash_or_bank,link.account_kind==="sales_cash");
  }
  const groups=await runtime.pool.query<{code:string;name:string}>(
    `SELECT code,name FROM accounts WHERE company_id=$1 AND code IN ('1113000000','1140000000') ORDER BY code`,
    [first.id],
  );
  assert.deepEqual(groups.rows,[
    {code:"1113000000",name:"الحوافظ"},
    {code:"1140000000",name:"سلف الموظفين"},
  ]);
  const duplicate=await admin.request("POST",`/companies/${first.id}/employees`,{
    userId:id1.id,name:"أحمد",phone:"",role:"sales",permissions:[],createSalesCashbox:true,
  });
  assert.equal(duplicate.status,409);
  assert.equal((await runtime.pool.query(
    "SELECT count(*)::int AS count FROM employee_account_links WHERE company_id=$1",
    [first.id],
  )).rows[0].count,7);
  const unknownUser=await identity();
  const before=await runtime.pool.query("SELECT count(*)::int AS total FROM accounts WHERE company_id=$1",[first.id]);
  await runtime.pool.query(`CREATE FUNCTION test_reject_employee_accounts_audit() RETURNS trigger
   LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='employee.create' THEN
    RAISE EXCEPTION 'test reject employee create'; END IF; RETURN NEW; END $$`);
  await runtime.pool.query(`CREATE TRIGGER test_reject_employee_accounts_audit BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION test_reject_employee_accounts_audit()`);
  try {
    assert.equal((await admin.request("POST",`/companies/${first.id}/employees`,{
      userId:unknownUser.id,name:"فشل اختبار",phone:"",role:"sales",
      permissions:[],createSalesCashbox:true,
    })).status,500);
  } finally {
    await runtime.pool.query("DROP TRIGGER test_reject_employee_accounts_audit ON audit_events");
    await runtime.pool.query("DROP FUNCTION test_reject_employee_accounts_audit()");
  }
  assert.equal((await runtime.pool.query(
    "SELECT count(*)::int AS total FROM accounts WHERE company_id=$1",[first.id]
  )).rows[0].total,before.rows[0].total);
  assert.equal((await runtime.pool.query(
    "SELECT count(*)::int AS total FROM employees WHERE company_id=$1 AND user_id=$2",
    [first.id,unknownUser.id],
  )).rows[0].total,0);
  // Existing users who predate auto-provisioning have no inferred account.
  const legacyUser = await identity();
  const legacyRow = await runtime.pool.query(
    `INSERT INTO employees(company_id,user_id,name,phone,role,active,permissions,created_by)
     VALUES($1,$2,$3,'','sales',true,'{}'::text[],$4) RETURNING id`,
    [first.id, legacyUser.id, "موظف سابق", owner.id],
  );
  const legacyId: number=legacyRow.rows[0].id;
  const linkPath=`/companies/${first.id}/employees/${legacyId}/accounts`;
  type Details = {accounts:{
    employeeId:number;
    links: {kind:string;accountId:number;code:string;name:string}[];
    walletAccount:{id:number;code:string;name:string}|null;
  }};
  const beforeLegacy=await admin.ok<Details>("GET",linkPath);
  assert.equal(beforeLegacy.accounts.links.length,0);
  assert.equal(beforeLegacy.accounts.walletAccount,null);
  assert.equal((await legacyUser.client.request("POST",linkPath,{createSalesCashbox:true})).status,403);
  const filled=await admin.ok<Details>("POST",linkPath,{createSalesCashbox:false});
  assert.equal(filled.accounts.links.length,1);
  assert.match(filled.accounts.links[0]!.name,/سلفة موظف سابق/);
  assert.equal(filled.accounts.walletAccount?.id,filled.accounts.links[0]!.accountId);
  const repeated=await admin.ok<Details>("POST",linkPath,{createSalesCashbox:false});
  assert.deepEqual(repeated.accounts,filled.accounts);
  const ready=await admin.ok<Details>("POST",linkPath,{createSalesCashbox:true});
  assert.deepEqual(ready.accounts.links.map(x=>x.kind).sort(),
    ["advance","sales_cash","sales_pouch"]);
  assert.equal(ready.accounts.walletAccount?.id,filled.accounts.walletAccount?.id);
  assert.equal((await admin.ok<Details>("POST",linkPath,{createSalesCashbox:true})).accounts.links.length,3);
  // The platform owner can link their EXISTING login as an employee in a company:
  // it is not necessary to register a second admin identity.
  const selfEmployee=await create(first.id, owner.id, "admin المالك", false);
  assert.match(selfEmployee.accounts[0]!.code,/^1140/);
  const selfDetails=await admin.ok<Details>(
    "GET",`/companies/${first.id}/employees/${selfEmployee.employee.id}/accounts`,
  );
  assert.equal(selfDetails.accounts.walletAccount?.id,
    selfEmployee.accounts[0]!.accountId);
  // A pre-existing manual wallet destination is not silently overwritten.
  const manualUser=await identity();
  const manualEmployee=await runtime.pool.query(
    `INSERT INTO employees(company_id,user_id,name,phone,role,active,permissions,created_by)
     VALUES($1,$2,'سلفة يدوية','','sales',true,'{}'::text[],$3) RETURNING id`,
    [first.id, manualUser.id, owner.id],
  );
  const manualId=manualEmployee.rows[0].id as number;
  const legacyTarget=firstEmployee.accounts.find(a=>a.kind==="advance")!;
  await runtime.pool.query(
    `INSERT INTO employee_wallet_accounts(company_id,employee_id,account_id,updated_by)
     VALUES($1,$2,$3,$4)`,
    [first.id,manualId,legacyTarget.accountId,owner.id],
  );
  const manualResult=await admin.ok<Details>(
    "POST",`/companies/${first.id}/employees/${manualId}/accounts`,
    {createSalesCashbox:true},
  );
  assert.equal(manualResult.accounts.links.length,3);
  assert.notEqual(manualResult.accounts.links.find(a=>a.kind==="advance")?.accountId,
    legacyTarget.accountId);
  assert.equal(manualResult.accounts.walletAccount?.id,legacyTarget.accountId);

});
