import assert from "node:assert/strict";
import {test} from "node:test";
import {canSearchDockUsers,dockUserSearchNames,dockUserSearchPath} from "../apps/web/src/dock-user-search.ts";

test("global users lookup requires owner and confirmed Users route access, never employee access",()=>{
  const page={key:"public.users",enabled:true,actionAccess:{view:true}};
  assert.equal(canSearchDockUsers({owner:true},[page]),true);
  assert.equal(canSearchDockUsers({owner:false},[page]),false);
  assert.equal(canSearchDockUsers({owner:true},[{...page,key:"company.employees"}]),false);
  assert.equal(canSearchDockUsers({owner:true},[{...page,actionAccess:{view:false}}]),false);
  assert.equal(canSearchDockUsers({owner:true},[{...page,enabled:false}]),false);
  assert.equal(canSearchDockUsers({owner:true},undefined),false);
});

test("lookup uses paged users q, encodes input, and projects only id and visible name",()=>{
  const path=dockUserSearchPath("  ريم & س  ");
  const url=new URL(path!,"https://test.invalid");
  assert.equal(url.pathname,"/users");
  assert.equal(url.searchParams.get("q"),"ريم & س");
  assert.equal(url.searchParams.get("pageSize"),"10");
  assert.equal(dockUserSearchPath("   "),null);
  const wire=[{id:4,displayName:" ريم ",name:"internal",email:"private",phone:"private"},
    {id:6,displayName:" ",name:"سالم",category:"secret"},{id:-1,name:"invalid"}];
  assert.deepEqual(dockUserSearchNames(wire),[{id:4,name:"ريم"},{id:6,name:"سالم"}]);
});
