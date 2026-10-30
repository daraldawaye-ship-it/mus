import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Account } from "../packages/contracts/src/index.ts";
import { ownActiveSalesCashbox, type LinkedCashboxSnapshot } from "../apps/web/src/employee-cashbox-cache.ts";

const companyId=2, employeeId=5, userId=19;
const account = {
  id:17,companyId,code:"1111000003",name:"صندوق مبيعات الموظف",
  active:true,kind:"posting",cashOrBank:true,
} as Account;
const linked: LinkedCashboxSnapshot={
  account,offlineIdentity:{userId,companyId,employeeId},
};
test("online and offline both use the same active cashbox linked to the current user",()=>{
  assert.equal(ownActiveSalesCashbox({account},userId,companyId,employeeId,false),account);
  assert.equal(ownActiveSalesCashbox(linked,userId,companyId,employeeId,true),account);
});
test("offline selection refuses another user, company or employee and missing proof",()=>{
  assert.equal(ownActiveSalesCashbox(linked,userId+1,companyId,employeeId,true),null);
  assert.equal(ownActiveSalesCashbox(linked,userId,companyId+1,employeeId,true),null);
  assert.equal(ownActiveSalesCashbox(linked,userId,companyId,employeeId+1,true),null);
  assert.equal(ownActiveSalesCashbox({account},userId,companyId,employeeId,true),null);
  assert.equal(ownActiveSalesCashbox({...linked,account:null},userId,companyId,employeeId,true),null);
});
test("only active company posting cash accounts are eligible",()=>{
  const invalidAccounts: Partial<Account>[] = [
    {active:false},{kind:"group"},{cashOrBank:false},{companyId:companyId+1},
  ];
  for (const change of invalidAccounts) {
    assert.equal(ownActiveSalesCashbox({...linked,account:{...account,...change}},userId,companyId,employeeId,true),null);
  }
});
test("offline cashbox and company queries never pause when browser goes offline",()=>{
  const hook=readFileSync("apps/web/src/employee-cashbox.ts","utf8");
  const app=readFileSync("apps/web/src/App.tsx","utf8");
  const storage=readFileSync("apps/web/src/offline-storage.ts","utf8");
  const invoice=readFileSync("apps/web/src/pages/CommercePages.tsx","utf8");
  assert.match(hook,/networkMode: "always"/);
  assert.match(app,/const company = useQuery\(\{[\s\S]*?networkMode: "always"/);
  assert.match(hook,/await savedRead<LinkedCashboxSnapshot>\(path\)/);
  assert.match(hook,/await rememberRead\(path,\{/);
  assert.match(hook,/offlineIdentity:\{userId,companyId,employeeId\}/);
  assert.match(hook,/queryKey: \["employee-sales-cashbox", user\?\.id, companyId, employeeId\]/);
  assert.match(storage,/my-sales-cashbox/);
  assert.match(invoice,/initialInvoiceAccount\(kind, defaultCashbox, configuredPurchaseAccount\)/);
  assert.match(invoice,/accountManuallyChosen\.current/);
});
test("purchases remain on their separately configured default, never the sales cashbox",()=>{
  const f=readFileSync("apps/web/src/invoice-account-default.ts","utf8");
  assert.match(f,/kind === "sale" \? employeeCashbox : configuredPurchaseAccount/);
});
