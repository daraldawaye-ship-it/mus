import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile} from "node:fs/promises";
import {canSearchDockUsers,dockUserCollisionIds,dockUserSearchNames,dockUserSearchPath} from "../apps/web/src/dock-user-search.ts";

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

test("distinguishes only same-label distinct accounts using existing IDs",()=>{
  const projected=dockUserSearchNames([
    {id:11,displayName:"اسم مشترك",name:"secret1"},
    {id:22,displayName:" اسم مشترك ",name:"secret2"},
    {id:33,displayName:"اسم فريد",name:"secret3"},
    {id:33,displayName:"اسم فريد"},
  ]);
  assert.deepEqual([...dockUserCollisionIds(projected)],[11,22]);
  assert.deepEqual(projected.map(x=>Object.keys(x)),Array.from({length:4},()=>["id","name"]));
});

test("selection holds the exact account, never a company employee ID",async()=>{
  const view=await readFile(new URL("../apps/web/src/WorkPanelUserSearch.tsx",import.meta.url),"utf8");
  assert.match(view,/setSelected\(\{\.\.\.row,showId\}\)/);
  assert.match(view,/dockSelection\.kind==="user" \? \{id:dockSelection\.id/);
  assert.match(view,/setInput\(event\.currentTarget\.value\);setSelected\(null\)/);
  assert.match(view,/const showId=collisionIds\.has\(row\.id\)/);
});
