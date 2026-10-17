import test from "node:test";
import assert from "node:assert/strict";
import { positionShortcutFlyout } from "../apps/web/src/shortcut-position.ts";

test("profile shortcuts on a narrow screen open inside menu rather than off the left edge",()=>{
  // Reproduces the screenshot: avatar menu occupies x≈35..458 in a 584px viewport.
  const p=positionShortcutFlyout(
    {left:35,right:458,top:354},{width:584,height:900},
  );
  assert.deepEqual(p,{mode:"inline"});
});

test("profile shortcuts open toward available viewport space on both physical sides",()=>{
  const right=positionShortcutFlyout(
    {left:35,right:458,top:354},{width:1440,height:900},
  );
  assert.equal(right.mode,"side");
  if(right.mode!=="side")return;
  assert.equal(right.side,"right");
  assert(right.left>=0 && right.left+right.width<=1440);

  const left=positionShortcutFlyout(
    {left:1000,right:1385,top:354},{width:1440,height:900},
  );
  assert.equal(left.mode,"side");
  if(left.mode!=="side")return;
  assert.equal(left.side,"left");
  assert(left.left>=0 && left.left+left.width<=1440);
});

test("profile shortcuts shrink and clamp top and left when side space is limited",()=>{
  const p=positionShortcutFlyout(
    {left:262,right:602,top:740},{width:800,height:800},
  );
  assert.equal(p.mode,"side");
  if(p.mode!=="side")return;
  assert.equal(p.side,"left");
  assert(p.width>=220 && p.width<290);
  assert(p.left>=8 && p.left+p.width<=792);
  assert(p.top>=8 && p.top+p.maxHeight<=792,
    "Tall flyouts must not fall below the viewport");
});

test("profile shortcut geometry is independent of RTL and prevents overflow on phones",()=>{
  for(const width of [320,375,414,584,700,768,1024,1440]){
    for(const left of [8,38,Math.max(8,width-440)]){
      const right=Math.min(width-8,left+Math.min(400,width-16));
      const p=positionShortcutFlyout(
        {left,right,top:Math.min(600,width)}, {width,height:740},
      );
      if(p.mode==="side"){
        assert(p.left>=7.999, `left overflow at ${width}:${left}`);
        assert(p.left+p.width<=width-7.999, `right overflow at ${width}:${left}`);
        assert(p.top>=8);
        assert(p.top+p.maxHeight<=732);
      }
    }
  }
});
