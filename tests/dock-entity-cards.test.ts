import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {dockAccountAccess,dockAccountCardPath,dockVerifiedAccount,dockPageCardEntry} from "../apps/web/src/dock-card-access.ts";

const page=(key:string,enabled=true,view=true,scope:"company"|"public"="company")=>({key,enabled,actionAccess:{view},scope});
const pages=[page("company.accounts"),page("company.account-ledger")];
const company=(permissions:string[],general=false)=>({company:{id:2},permissions,general});
test("account card and inline ledger require separate effective module and exact page read access",()=>{
  assert.deepEqual(dockAccountAccess(company(["accounts.view"]),pages),{card:true,ledger:false});
  assert.deepEqual(dockAccountAccess(company(["finance.view"]),pages),{card:false,ledger:true});
  assert.deepEqual(dockAccountAccess(company([],true),[page("company.accounts",false),page("company.account-ledger",true,false)]),{card:false,ledger:false});
  assert.deepEqual(dockAccountAccess(undefined,pages),{card:false,ledger:false});
  assert.deepEqual(dockAccountAccess(company([],true),undefined),{card:false,ledger:false});
});
test("exact positive account id and tenant response and current page scope are verified",()=>{
  assert.equal(dockAccountCardPath(2,88),"/companies/2/accounts/88");
  for(const impossible of [0,NaN,-1,2.3,2_147_483_648])assert.equal(dockAccountCardPath(2,impossible),null);
  assert.equal(dockVerifiedAccount({companyId:3,id:88},2,88),undefined);
  assert.equal(dockVerifiedAccount({companyId:2,id:87},2,88),undefined);
  assert.deepEqual(dockVerifiedAccount({companyId:2,id:88},2,88),{companyId:2,id:88});
  assert.equal(dockPageCardEntry(pages,"company.accounts",undefined),undefined);
  assert.equal(dockPageCardEntry(pages,"company.accounts",2),pages[0]);
  assert.equal(dockPageCardEntry([page("company.accounts",true,false)],"company.accounts",2),undefined);
  const global=page("public.users",true,true,"public");
  assert.equal(dockPageCardEntry([global],"public.users",undefined),global);
});
test("inline ledger reuses exact selected account, employee reference does not set an exact user card",async()=>{
  const file=(name:string)=>readFile(new URL("../apps/web/src/"+name,import.meta.url),"utf8");
  const account=await file("DockAccountTools.tsx");
  assert.match(account,/LedgerPreview companyId=\{companyId\} account=\{selected\} hideFullLink/);
  assert.equal((account.match(/<Dialog/g)??[]).length,1);
  const user=await file("WorkPanelUserSearch.tsx");
  assert.match(user,/dockSelection\.kind==="user" \? \{id:dockSelection\.id[^\n]*: null/);
  assert.match(user,/userId=\{verifiedSelection\} actorId=\{user\.id\}/);
  const page=await file("WorkPanelPageSearch.tsx");
  assert.match(page,/String\(companyId\)===routeCompany/);
  assert.match(page,/dockPageCardEntry\(pages,activeKey,companyMatches\?companyId:undefined\)/);
});
