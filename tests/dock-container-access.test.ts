import test from "node:test";
import assert from "node:assert/strict";
import {dockContainerRoles,dockDataReads} from "../apps/web/src/dock-container-access.ts";
const member={owner:false,suspended:false,archived:false};
const company=(positions:string[],permissions:string[]=[],active=true)=>({general:false,employee:{active,positions},permissions});
const page=(key:string,view=true)=>({key,enabled:true,actionAccess:{view}});
test("dock container roles require real active company context, without changing the authenticated shell",()=>{
 const visible=(input:ReturnType<typeof dockContainerRoles>)=>Object.entries(input).filter(([key,value])=>key!=="shell"&&key!=="owner"&&value).map(([key])=>key);
 for(const [role,expected] of [["sales",["item","overview"]],["cashier",["item","account","overview"]],["purchase-entry",[]]] as const){
  const profile=company([role]);
  assert.deepEqual(visible(dockContainerRoles(member,profile,true,false,false)),expected);
  assert.deepEqual(visible(dockContainerRoles(member,profile,false,false,false)),[]);
 }
 assert.equal(dockContainerRoles(member,undefined,false,false,false).shell,true);
 assert.deepEqual(visible(dockContainerRoles({...member,owner:true},undefined,true,false,false)),["item","account","user","page","overview"]);
 assert.equal(dockContainerRoles(null,undefined,false,false,false).shell,false);
 assert.equal(dockContainerRoles(member,undefined,false,true,false).shell,false);
 assert.equal(dockContainerRoles(member,undefined,false,false,true).shell,false);
 assert.deepEqual(visible(dockContainerRoles(member,company(["cashier"],[],false),true,false,false)),[]);
});
test("container role alone grants no item, inventory, finance or ledger reads",()=>{
 assert.deepEqual(dockDataReads(company(["cashier"]),undefined),{item:false,account:false,movement:false,purchases:false,alternatives:false,card:false});
 assert.equal(dockDataReads(company(["sales"],["commerce.view"]),[]).item,true);
 assert.equal(dockDataReads(company(["cashier"],["accounts.view"]),[page("company.accounts"),page("company.financial-documents")]).account,true);
 assert.equal(dockDataReads(company(["cashier"],["finance.view"]),[page("company.accounts"),page("company.financial-documents",false)]).account,false);
 const p=[page("company.stock-movements"),page("company.purchases",false)];
 assert.equal(dockDataReads(company(["cashier"],["inventory.view"]),p).movement,true);
 assert.equal(dockDataReads(company(["cashier"],["inventory.view"]),p).purchases,false);
 assert.equal(dockDataReads(company(["cashier"],["items.view"]),[page("company.items")]).alternatives,false);
});
