import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {dockSearchPlacement} from "../apps/web/src/dock-search-placement.ts";
const rect=(left:number,top:number,width:number,height:number)=>({left,top,right:left+width,bottom:top+height});
test("results fit their input and stay in the visual viewport with keyboard and scrolling",()=>{
 const view={top:0,left:0,width:360,height:720};
 assert.deepEqual(dockSearchPlacement(rect(10,88,320,38),view),{left:10,width:320,top:130,maxHeight:240,side:"below"});
 assert.deepEqual(dockSearchPlacement(rect(20,443,300,38),{...view,height:500}),{left:20,width:300,top:439,maxHeight:240,side:"above"});
 const moved=dockSearchPlacement(rect(15,280,330,35),{top:60,left:20,width:320,height:245});
 assert.deepEqual(moved,{left:26,width:308,top:276,maxHeight:210,side:"above"});
 assert.equal(dockSearchPlacement(rect(10,42,320,37),view,rect(0,100,350,220)),null);
 assert.equal(dockSearchPlacement(rect(10,15,80,12),{...view,height:43}),null);
});
test("all four dock result types use the out-of-flow portal; avatar flow and modal priority stay intact",async()=>{
 const fromFile=(name:string)=>readFile(new URL("../apps/web/src/"+name,import.meta.url),"utf8");
 const overlay=await fromFile("DockSearchResults.tsx"),css=await fromFile("WorkPanelLayout.css");
 assert.match(overlay,/createPortal\([\s\S]*,document\.body\)/);
 assert.match(overlay,/window\.addEventListener\("scroll",schedule,\{capture:true/);
 assert.match(overlay,/viewport\?\.addEventListener\("resize"/);
 assert.match(css,/\.dock-search-results-layer \{[^}]*position: fixed;[^}]*overflow-y: auto/);
 assert.match(css,/body:has\(dialog\[open\]\) > \.dock-search-results-layer \{ display:none/);
 const dock=await fromFile("WorkPanelTools.tsx");
 assert.match(dock,/kind="item" floatingResults/);
 assert.match(dock,/kind="account" floatingResults/);
 const shared=await fromFile("EntityMenuSearch.tsx");
 assert.match(shared,/floatingResults=false/);
 assert.match(shared,/floatingResults\s*\? <DockSearchResults[\s\S]*: suggestions/);
 for(const kind of ["User","Page"]){
  assert.match(await fromFile("WorkPanel"+kind+"Search.tsx"),/<DockSearchResults[\s\S]*role="status"/);
 }
 const user=await fromFile("WorkPanelUserSearch.tsx");
 assert.match(user,/isDockResultFocus\(resultsId,event\.relatedTarget\)/);
});
