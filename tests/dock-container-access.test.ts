import test from "node:test";
import assert from "node:assert/strict";
import {dockContainerRoles,dockDataReads,dockItemViewOptions} from "../apps/web/src/dock-container-access.ts";
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
 assert.deepEqual(dockDataReads(company(["cashier"]),undefined),{item:false,account:false,statementOnlyAccountSearch:false,movement:false,purchases:false,alternatives:false,card:false});
 assert.equal(dockDataReads(company(["sales"],["commerce.view"]),[]).item,true);
 assert.equal(dockDataReads(company(["cashier"],["accounts.view"]),[page("company.accounts"),page("company.financial-documents")]).account,true);
 assert.equal(dockDataReads(company(["cashier"],["finance.view"]),[page("company.accounts"),page("company.financial-documents",false)]).account,false);
 const p=[page("company.stock-movements"),page("company.purchases",false)];
 assert.equal(dockDataReads(company(["cashier"],["inventory.view"]),p).movement,true);
 assert.equal(dockDataReads(company(["cashier"],["inventory.view"]),p).purchases,false);
 assert.equal(dockDataReads(company(["cashier"],["items.view"]),[page("company.items")]).alternatives,false);
});

test("all four dock views remain visible but denied reads stay disabled",()=>{
 const staff=company(["sales"],["commerce.view"]);
 const exposed=dockItemViewOptions(dockDataReads(staff,[]),true);
 assert.deepEqual(exposed.map(v=>[v.key,v.available]),[
  ["movement",true],["purchases",true],["card",false],["alternatives",false],
 ]);
 const allowed=dockItemViewOptions(dockDataReads(company(["sales"],["items.view"]),
  [page("company.items"),page("company.item-card")]),true);
 assert.deepEqual(allowed.map(v=>v.available),[true,true,true,true]);
});
test("cashier with statement permission can select a posting account without gaining card access",()=>{
 const cashier=company(["cashier"],["finance.view"]);
 const statement=page("company.account-ledger");
 assert.equal(dockDataReads(cashier,[statement]).account,true);
 assert.equal(dockDataReads(cashier,[statement]).statementOnlyAccountSearch,true);
 assert.equal(dockDataReads(cashier,[statement,page("company.financial-documents")]).statementOnlyAccountSearch,false);
 assert.equal(dockDataReads(cashier,[page("company.account-ledger",false)]).account,false);
 assert.equal(dockDataReads(company(["cashier"]),[statement]).account,false);
 assert.equal(dockContainerRoles(member,company(["sales"],["finance.view"]),true,false,false).account,false);
});
