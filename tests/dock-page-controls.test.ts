import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {dockPageControls} from "../apps/web/src/dock-page-control-access.ts";
const entry={key:"company.my-cashbox-ledger",scope:"company" as const,enabled:true,critical:false,canConfigure:true,actionAccess:{view:true,edit:false}};
const center={...entry,key:"company.central-access",actionAccess:{view:true,edit:true}};
const general={company:{id:2},general:true}, employee={...general,general:false};
const gate=(patch:Partial<Parameters<typeof dockPageControls>[0]>={})=>dockPageControls({
  entry,centralPage:center,context:general,owner:false,preview:false,...patch,
});

test("company settings and central position security are independent and default denied",()=>{
  assert.deepEqual(gate(),{companyId:2,settings:true,centralRead:true,centralEdit:true});
  assert.deepEqual(gate({context:employee}),{companyId:2,settings:true,centralRead:false,centralEdit:false});
  assert.deepEqual(gate({entry:{...entry,canConfigure:false}}),{companyId:2,settings:false,centralRead:true,centralEdit:true});
  assert.deepEqual(gate({centralPage:{...center,actionAccess:{view:true,edit:false}}}),{companyId:2,settings:true,centralRead:true,centralEdit:false});
  assert.equal(gate({centralPage:{...center,actionAccess:{view:false,edit:true}}}).centralRead,false);
  assert.equal(gate({centralPage:{...center,enabled:false}}).centralEdit,false);
  assert.equal(gate({centralPage:undefined}).centralRead,false);
  assert.equal(gate({entry:{...entry,critical:true}}).settings,false);
  assert.deepEqual(gate({preview:true,owner:true}),{companyId:2,settings:false,centralRead:false,centralEdit:false});
});

test("disabled/unreadable pages are never editable in the dock; public settings remain owner only and unscoped",()=>{
  for(const unavailable of [ {...entry,enabled:false},{...entry,actionAccess:{view:false,edit:true}} ]) {
    assert.deepEqual(gate({entry:unavailable,owner:true}),{companyId:2,settings:false,centralRead:false,centralEdit:false});
  }
  const publicEntry={...entry,scope:"public" as const,key:"public.companies"};
  assert.deepEqual(gate({entry:publicEntry,owner:true}),{companyId:undefined,settings:true,centralRead:false,centralEdit:false});
  assert.equal(gate({entry:publicEntry}).settings,false);
  assert.equal(gate({context:undefined,owner:true}).settings,false);
});

test("dock reuses canonical revision-safe settings and central resource editors, never legacy grants",async()=>{
  const file=(name:string)=>readFile(new URL("../apps/web/src/"+name,import.meta.url),"utf8");
  const dock=await file("DockPageCardBody.tsx");
  assert.match(dock,/<PageDetails entry=\{entry\}[\s\S]*?settingsOnly/);
  assert.match(dock,/controls\.centralRead&&<DockCentralPagePositions/);
  assert.match(dock,/resource\.kind==="page"&&resource\.key===`page:\$\{entry\.key\}`/);
  assert.match(dock,/resource\.policy\?\.viewPositions/);
  assert.match(dock,/resource\.policy\?\.editPositions/);
  assert.match(dock,/editing&&<CentralResourceEditor/);
  assert.doesNotMatch(dock,/\/grants|PagePermissionCard/);
  const search=await file("WorkPanelPageSearch.tsx");
  assert.match(search,/JSON\.stringify\(\[user\.id,companyMatches\?companyId:null,entry\.key,currentRoute\]\)/);
  assert.match(search,/<PageCard key=\{cardKey\} entry=\{entry\}/);
  const directory=await file("pages/PageDirectoryPage.tsx");
  assert.match(directory,/if \(settingsOnly\) return settingsAndStatus;[\s\S]*<PagePermissionCard/);
  assert.match(directory,/companyId: companyId \?\? null,[\s\S]*revision,/);
  const centerPage=await file("pages/CentralAccessPage.tsx");
  assert.match(centerPage,/api\(base,\{method:"PUT",signal:guard\.signal/);
  assert.match(centerPage,/viewPositions:view,editPositions:edit,revision:resource\.policy\?\.revision\?\?null/);
});
