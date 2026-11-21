import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {PGlite} from "@electric-sql/pglite";
import {centralResource} from "../apps/api/src/services/central-access-catalog.ts";
import {rolePermissionTemplates,permissionKeys} from "../packages/contracts/src/index.ts";
import {showWorkPanelAccountSearch,showWorkPanelPageSearch,findWorkPanelPages,accountSearchPermission,pageSearchPermission} from "../apps/web/src/work-panel-search-access.ts";

const owner={owner:true,kind:"admin"}, employee={owner:false,kind:"member"};
const company=(raw:string[],effective:string[]=["accounts.view"])=>({employee:{permissions:raw},permissions:effective});
const item=(changes={})=>({key:"company.accounts",name:"دليل الحسابات",order:2,scope:"company" as const,
  visible:true,enabled:true,navigation:true,href:"/companies/15/accounts",actionAccess:{view:true},...changes});

test("owner default and both worker permissions independent; preview and missing account rights deny",()=>{
  assert.equal(showWorkPanelAccountSearch(owner,undefined,undefined,false),true);
  assert.equal(showWorkPanelPageSearch(owner,undefined,false),true);
  assert.equal(showWorkPanelAccountSearch(employee,company([]),[item()],false),false);
  assert.equal(showWorkPanelPageSearch(employee,company([]),false),false);
  assert.equal(showWorkPanelAccountSearch(employee,company([accountSearchPermission]),[item()],false),true);
  assert.equal(showWorkPanelPageSearch(employee,company([accountSearchPermission]),false),false);
  assert.equal(showWorkPanelPageSearch(employee,company([pageSearchPermission]),false),true);
  assert.equal(showWorkPanelAccountSearch(employee,company([pageSearchPermission]),[item()],false),false);
  assert.equal(showWorkPanelAccountSearch(employee,company([accountSearchPermission],[]),[item()],false),false);
  assert.equal(showWorkPanelAccountSearch(employee,company([accountSearchPermission]),[item({actionAccess:{view:false}})],false),false);
  assert.equal(showWorkPanelAccountSearch(employee,company([accountSearchPermission]),undefined,false),false);
  assert.equal(showWorkPanelPageSearch(employee,company([pageSearchPermission]),true),false);
  assert.equal(showWorkPanelAccountSearch(owner,undefined,undefined,true),false);
});

test("page search returns only sidebar-eligible current links and does not read unauthorized route names",()=>{
  const pages=[item(),item({key:"secret",href:"/companies/15/secret",visible:false}),
    item({key:"disabled",href:"/companies/15/disabled",enabled:false}),
    item({key:"forbidden",href:"/companies/15/forbidden",actionAccess:{view:false}}),
    item({key:"not-in-nav",href:"/companies/15/unlisted",navigation:false}),
    item({key:"wrong-company",href:"/companies/16/accounts"}),
    item({key:"outside",href:"//external.invalid/accounts"}),
    {...item({key:"public.users",href:"/users"}),scope:"public" as const},
    {...item({key:"public.home",href:"/",name:"السوق الرئيسي"}),scope:"public" as const}];
  assert.deepEqual(findWorkPanelPages(pages,employee,15,"الحِسابات"),[{key:"company.accounts",name:"دليل الحسابات",href:"/companies/15/accounts"}]);
  assert.deepEqual(findWorkPanelPages(pages,employee,16,"الحسابات").map(row=>row.key),["wrong-company"]);
  assert.deepEqual(findWorkPanelPages(pages,employee,undefined,"الحسابات"),[]);
  assert.deepEqual(findWorkPanelPages(pages,employee,15,"السوق").map(row=>row.href),["/medicine-market"]);
  assert.deepEqual(findWorkPanelPages(undefined,employee,15,"الحسابات"),[]);
});

test("both exact central permission entries persist under the migrated constraints, without default grants",async()=>{
  const db=await PGlite.create();
  try{
    const previous=new URL("../apps/api/migrations/092_my_cashbox_ledger.sql",import.meta.url);
    const patch=new URL("../apps/api/migrations/20261121_work_panel_search_permissions.sql",import.meta.url);
    await db.exec(`CREATE TABLE employees (id integer PRIMARY KEY, company_id integer, permissions text[] NOT NULL DEFAULT '{}',
      CONSTRAINT employees_permissions_check CHECK (permissions <@ ARRAY['accounts.view']::text[]));
      CREATE TABLE permission_definitions (required_permissions text[] CHECK (required_permissions <@ ARRAY['accounts.view']::text[]));
      INSERT INTO employees VALUES (11,15,'{accounts.view}'),(12,18,'{}');`);
    await db.exec((await readFile(previous,"utf8")).split("INSERT INTO page_registry")[0]!);
    await db.exec(await readFile(patch,"utf8"));
    for(const key of [accountSearchPermission,pageSearchPermission] as const){
      assert(permissionKeys.includes(key));
      assert.equal(centralResource("permission:"+key)?.integrated,true);
      assert.equal(centralResource("permission:"+key)?.kind,"permission");
      assert(Object.values(rolePermissionTemplates).every(preset=>!preset.includes(key)));
      await db.query("UPDATE employees SET permissions=array_append(permissions,$1) WHERE company_id=$2 AND id=$3",[key,15,11]);
    }
    assert.deepEqual((await db.query("SELECT permissions FROM employees ORDER BY id")).rows,
      [{permissions:["accounts.view",accountSearchPermission,pageSearchPermission]},{permissions:[]}]);
    await assert.rejects(db.query("UPDATE employees SET permissions=ARRAY['bad.perm'] WHERE id=11"));
  }finally{await db.close();}
});
