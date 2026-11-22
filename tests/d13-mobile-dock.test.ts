import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDockRowClick } from "../apps/web/src/dock-row-interaction.ts";
type RowClick=Parameters<typeof isDockRowClick>[0];

function tap(options:{detail?:number;touch?:boolean;interactive?:boolean;targetInside?:boolean;
    selecting?:boolean;modified?:boolean;prevented?:boolean;trusted?:boolean;pen?:boolean}={}):RowClick{
  const row={};
  return {currentTarget:row,
    target:{
      closest:(selector:string)=>selector==="tr"||selector===".item-order-drafts-mobile-card"||selector===".item-options-mobile-entry"
        ? options.targetInside===false?{}:row : options.interactive?{}:null,
      ownerDocument:{getSelection:()=>options.selecting
        ? {isCollapsed:false,containsNode:()=>true} : null},
    },
    detail:options.detail??1,defaultPrevented:options.prevented??false,altKey:false,
    ctrlKey:options.modified??false,shiftKey:false,metaKey:false,
    nativeEvent:{isTrusted:options.trusted??true,pointerType:options.touch?"touch":options.pen?"pen":"mouse"},
  } as unknown as RowClick;
}
test("desktop and mobile genuine row interactions synchronize",()=>{
  assert.equal(isDockRowClick(tap(),"tr"),true);
  assert.equal(isDockRowClick(tap({touch:true,detail:0}),"tr"),true);
  assert.equal(isDockRowClick(tap({touch:true,detail:0}),".item-order-drafts-mobile-card"),true);
  assert.equal(isDockRowClick(tap({pen:true,detail:0}),"tr"),true);
  assert.equal(isDockRowClick(tap({touch:true,detail:0}),".item-options-mobile-entry"),true);
});
test("nested controls, selection and synthetic zero-count clicks do not synchronize",()=>{
  for(const options of [{interactive:true,touch:true},{targetInside:false},
    {selecting:true,touch:true},{modified:true},{detail:2},{detail:0,touch:true,trusted:false},
    {detail:0},{prevented:true}]){
    assert.equal(isDockRowClick(tap(options),"tr"),false,JSON.stringify(options));
  }
});
test("the table and draft mobile card both use verified sources via the guarded update",()=>{
  const table=readFileSync(new URL("../apps/web/src/InteractiveColumnsTable.tsx",import.meta.url),"utf8");
  const drafts=readFileSync(new URL("../apps/web/src/pages/ItemOrderDraftsPage.tsx",import.meta.url),"utf8");
  assert.match(table,/isDockRowClick\(event,"tr"\)[\s\S]+updateDock\(dockRowSource\(item.row\)\)/);
  assert.match(drafts,/isDockRowClick\(event,".item-order-drafts-mobile-card"\)[\s\S]+updateDock\(\{companyId,itemId:row.item.id,itemName:row.item.name\}\)/);
});

test("item options share the same verified identity between cards and D13",()=>{
  const options=readFileSync(new URL("../apps/web/src/pages/ItemOptionsListPage.tsx",import.meta.url),"utf8");
  assert.match(options,/dockItemSource = \(row: Row\) => \(\{ companyId, itemId: row.itemId, itemName: row.name \}\)/);
  assert.match(options,/isDockRowClick\(event, ".item-options-mobile-entry"\)[\s\S]+updateDock\?\.\(dockItemSource\(row\)\)/);
  assert.match(options,/dockRowSource=\{dockItemSource\}/);
});
