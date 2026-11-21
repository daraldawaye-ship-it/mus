import assert from "node:assert/strict";
import {test} from "node:test";
import {mobileWorkPanelAvailableHeight as height,mobileWorkPanelMaxSize as maxSize,watchMobileWorkPanelGeometry} from "../apps/web/src/work-panel-viewport.ts";

test("mobile shell follows keyboard and restore, offset, scroll, fallback, and not zoom",()=>{
  assert.equal(height(40,842,{height:602,offsetTop:0,scale:1}),562);
  assert.equal(height(40,842,{height:842,offsetTop:0,scale:1}),802);
  assert.equal(height(-35,842,{height:602,offsetTop:55,scale:1}),692);
  assert.equal(height(40,540,undefined),500);
  assert.equal(height(40,540,{height:0,offsetTop:0,scale:1}),500);
  assert.equal(height(40,842,{height:250,offsetTop:34,scale:1.2}),null);
  assert.equal(height(45,360,{height:180,offsetTop:0,scale:1}),135);
});

test("persisted expanded size can restore after a temporary clamp; collapsed rail is stable",()=>{
  const persisted=320,rail=30;
  assert.equal(Math.min(persisted,maxSize(230,rail)),100);
  assert.equal(Math.min(persisted,maxSize(780,rail)),320);
  assert.equal(maxSize(35,rail),31);
});

test("visual changes coalesce; Back without resize can restore via sample while still focused",()=>{
  let n=0, focused=false, innerHeight=820;
  const frames=new Map<number,()=>void>(), timeouts=new Map<number,()=>void>(), intervals=new Map<number,()=>void>();
  const flush=(pending:Map<number,()=>void>)=>{const list=[...pending.values()];pending.clear();list.forEach(f=>f());};
  const win=Object.assign(new EventTarget(),{
    requestAnimationFrame(f:()=>void){frames.set(++n,f);return n;},
    cancelAnimationFrame(id:number){frames.delete(id);},
    setTimeout(f:()=>void){timeouts.set(++n,f);return n;},
    clearTimeout(id:number){timeouts.delete(id);},
    setInterval(f:()=>void){intervals.set(++n,f);return n;},
    clearInterval(id:number){intervals.delete(id);},
  });
  const document=Object.assign(new EventTarget(),{hidden:false}),viewport=Object.assign(new EventTarget(),{height:820,offsetTop:0,scale:1});
  const observed:(number|null)[]=[];
  const stop=watchMobileWorkPanelGeometry({win:win as unknown as Window,document:document as unknown as Document,viewport,
    focusWithinDock:()=>focused,measure:()=>{observed.push(height(40,innerHeight,viewport));}});
  flush(timeouts);flush(frames);
  assert.deepEqual(observed,[780]);
  focused=true;document.dispatchEvent(new Event("focusin"));flush(timeouts);
  viewport.height=560;viewport.dispatchEvent(new Event("resize"));viewport.dispatchEvent(new Event("scroll"));flush(frames);
  assert.deepEqual(observed,[780,520]);
  assert.equal(intervals.size,1);
  viewport.height=820;
  for(const f of intervals.values())f();flush(frames);
  assert.deepEqual(observed,[780,520,780]);
  focused=false;document.dispatchEvent(new Event("focusout"));flush(timeouts);flush(frames);
  assert.equal(intervals.size,0);
  innerHeight=430;viewport.height=430;win.dispatchEvent(new Event("resize"));flush(frames);
  assert.equal(observed.at(-1),390);
  win.dispatchEvent(new Event("pageshow"));stop();
  assert.equal(frames.size+timeouts.size+intervals.size,0);
  viewport.dispatchEvent(new Event("resize"));assert.equal(frames.size,0);
});
