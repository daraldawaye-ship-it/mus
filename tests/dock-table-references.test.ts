import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile} from "node:fs/promises";
import {dockReferences,type DockReferenceScope} from "../apps/web/src/dock-table-references.ts";
const scope:DockReferenceScope={companyId:4,companyRoute:true,userRoute:false,item:true,account:true,user:true};
test("named and verified typed fields populate several independent searches; unknown or ambiguous IDs do not",()=>{
  const row={id:99,itemId:1,itemName:"صنف",accountId:2,accountName:"حساب",employeeId:3,employeeName:"موظف"};
  assert.deepEqual(dockReferences(row,scope),[
    {id:1,name:"صنف",kind:"item"},{id:2,name:"حساب",kind:"account"},{id:3,name:"موظف",kind:"employee"},
  ]);
  assert.deepEqual(dockReferences({id:99,name:"General"},scope),[]);
  assert.deepEqual(dockReferences({id:99,name:"Known"},scope,"item"),[{id:99,name:"Known",kind:"item"}]);
  assert.equal(dockReferences({...row,counterpartyAccountId:4,counterpartyAccountName:"ثان"},scope).some(r=>r.kind==="account"),false);
  assert.deepEqual(dockReferences({supplierAccountId:2,supplierAccountName:"مقدر",supplierInferenceSource:"item_estimate"},scope),[]);
  assert.deepEqual(dockReferences({id:2,accountName:"لا يكفي"},scope),[]);
});
test("company, section, and global user identities remain separate",()=>{
  const row={companyId:7,itemId:1,itemName:"غير مصرح"};
  assert.deepEqual(dockReferences(row,scope),[]);
  assert.deepEqual(dockReferences({accountId:2,accountName:"حساب"}, {...scope,account:false}),[]);
  assert.deepEqual(dockReferences({id:2,name:"موظف",userId:82},scope,"employee"),[{id:2,name:"موظف",kind:"employee"}]);
  const global={...scope,companyRoute:false,userRoute:true};
  assert.deepEqual(dockReferences({id:82,displayName:"مستخدم",name:"Login"},global,"user"),[{id:82,name:"مستخدم",kind:"user"}]);
  assert.deepEqual(dockReferences({id:82,displayName:"مستخدم"},global),[]);
  assert.deepEqual(dockReferences({id:82,displayName:"مستخدم"},{...global,user:false},"user"),[]);
  assert.deepEqual(dockReferences({id:82,displayName:"مستخدم"},{...global,userRoute:false},"user"),[]);
});
test("table dispatch is additive and current page search opens results only after an explicit edit",async()=>{
  const ui=await readFile(new URL("../apps/web/src/ui.tsx",import.meta.url),"utf8");
  assert.match(ui,/event\.detail===1/);
  assert.match(ui,/selection\.containsNode/);
  assert.match(ui,/interactive\.hasAttribute\("data-dock-plain-value"\)/);
  assert.match(ui,/onClickCapture=\{\(\) => onRowInteract/);
  const page=await readFile(new URL("../apps/web/src/WorkPanelPageSearch.tsx",import.meta.url),"utf8");
  assert.match(page,/searching\?edit\.value:currentLabel/);
  assert.match(page,/searching&&query\.trim\(\)&&/);
});
