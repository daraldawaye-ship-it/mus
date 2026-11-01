import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { PageEntry } from "../packages/contracts/src/index.ts";
import {
  authorizedInvoiceShortcuts,
  COMPANY2_INVOICE_KEYS,
} from "../apps/api/src/services/company2-invoice-shortcut-defaults.ts";

type Entry = {key:string;enabled:boolean;href:string|null;record:boolean;
  actionAccess:{view:boolean;create:boolean}};
function entry(key:string,view=true,create=true):Entry {
  return {key,enabled:true,href:"/companies/2/"+key,record:false,
    actionAccess:{view,create}};
}
function directory(...overrides:Entry[]):PageEntry[] {
  const rows=[
    entry("company.invoice"),entry("company.sales"),
    entry("company.purchases"),entry("company.sale-new"),
    entry("company.purchase-new"),
  ];
  for(const changed of overrides){
    const index=rows.findIndex(row=>row.key===changed.key);
    if(index<0)rows.push(changed);
    else rows[index]=changed;
  }
  return rows as unknown as PageEntry[];
}
test("existing Dar Aldawa staff with both permissions receive both default shortcuts",()=>{
  assert.deepEqual(authorizedInvoiceShortcuts(directory()),COMPANY2_INVOICE_KEYS);
});
test("sale only / purchase only permissions do not accidentally grant the other action",()=>{
  assert.deepEqual(authorizedInvoiceShortcuts(directory(entry("company.purchase-new",true,false))),
    ["company.sale-new"]);
  assert.deepEqual(authorizedInvoiceShortcuts(directory(entry("company.sale-new",false,false))),
    ["company.purchase-new"]);
});
test("a disabled page, denied create or blocked parent is never a default",()=>{
  assert.deepEqual(authorizedInvoiceShortcuts(directory({...entry("company.sales"),enabled:false})),
    ["company.purchase-new"]);
  assert.deepEqual(authorizedInvoiceShortcuts(directory(entry("company.purchases",false))),
    ["company.sale-new"]);
  assert.deepEqual(authorizedInvoiceShortcuts(directory(entry("company.invoice",false))),[]);
});
test("defaults persist for existing staff, and manually removed links do not reappear",()=>{
  const startup=readFileSync("apps/api/src/index.ts","utf8");
  const service=readFileSync("apps/api/src/services/company2-invoice-shortcut-defaults.ts","utf8");
  const routes=readFileSync("apps/api/src/routes-shortcuts.ts","utf8");
  assert.match(startup,/await provisionExistingDarAldawaInvoiceShortcuts\(application\.pool\)/);
  assert.match(service,/WHERE e\.company_id=2 AND e\.user_id=u\.id AND e\.active/);
  assert.match(service,/invoice_defaults_seen/);
  assert.match(service,/!seen\.includes\(key\)/);
  assert.match(routes,/companyId===2/);
  assert.match(routes,/authorizedInvoiceShortcuts\(entries\)/);
  assert.match(routes,/invoice_defaults_seen=ARRAY/);
  // Explicit user shortcut updates must persist the selected list, never overwrite it.
  assert.match(routes,/page_keys=EXCLUDED\.page_keys/);
});
