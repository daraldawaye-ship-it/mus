import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import type {Request} from "express";
import type {Database} from "../apps/api/src/db.ts";
import {requestPermissionTargets} from "../apps/api/src/services/permission-rules.ts";
import {requestPageKeys} from "../apps/api/src/services/pages.ts";

const noDb={query(){throw new Error("Route classification must not hit the database");}} as unknown as Database;
const request=(path:string,query:Record<string,string>={})=>({originalUrl:"/api/companies/2/"+path,method:"GET",query} as unknown as Request);
test("statement details and picker have the same page and rule target",async()=>{
  for(const path of ["account-ledger","account-ledger/accounts"]){
    const req=request(path);
    assert.deepEqual(await requestPageKeys(noDb,req),{companyId:2,keys:["company.account-ledger"]});
    assert.deepEqual(await requestPermissionTargets(noDb,req,2,"finance.view"),[["company.account-ledger:view"]]);
  }
});
test("shared finance options still retain their separate controls",async()=>{
  const req=request("financial-options",{type:"accounts"});
  assert.deepEqual(await requestPageKeys(noDb,req),{companyId:2,keys:["company.financial-documents","company.accounts"]});
  assert.deepEqual(await requestPermissionTargets(noDb,req,2,"finance.view"),[["company.financial-documents:view","company.accounts:view"]]);
});
test("only account ledger lookup uses the minimal scoped endpoint",()=>{
  const code=readFileSync(new URL("../apps/api/src/routes-finance.ts",import.meta.url),"utf8");
  const start=code.indexOf("${base}/account-ledger/accounts");
  const lookup=code.slice(start,code.indexOf('${base}/account-ledger`',start));
  assert.match(lookup,/await readFinance/);
  assert.match(lookup,/a.company_id=\$1 AND a.kind='posting'/);
  assert.match(lookup,/SELECT a.id,a.code,a.name/);
  assert.doesNotMatch(lookup,/accountDTO|allowAccountRead|INSERT|UPDATE/);
  const web=readFileSync(new URL("../apps/web/src/pages/FinancePages.tsx",import.meta.url),"utf8");
  assert.match(web,/resource=\{pledge\s*\? `[^\n]*financial-options[^\n]*`\s*: `[^\n]*account-ledger\/accounts`\}/);
});
