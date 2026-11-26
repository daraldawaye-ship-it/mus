import assert from "node:assert/strict";
import {test} from "node:test";
import {buildImageAttributeIndex,matchImageAttributes} from "../apps/api/src/market-image-attributes.ts";
test("deeper stage resolves typography and equivalent dual strengths",()=>{
 const idx=buildImageAttributeIndex([{id:1,name:"سيبرودنك 500 ملج اقراص"},{id:2,name:"اوجمنتين 875 ملج / 125 ملج 14 اقراص"}],true);
 assert.equal(matchImageAttributes("سيبرو-دنك 500 مجم حبوب",idx,true)?.id,1);
 assert.equal(matchImageAttributes("أوجمنتين 875/125 مجم حبوب",idx,true)?.id,2);
 assert.equal(matchImageAttributes("أوجمنتين 125/875 مجم حبوب",idx,true),undefined);
 assert.equal(matchImageAttributes("أوجمنتين 875/125 مل حبوب",idx,true),undefined);
 assert.equal(matchImageAttributes("سيبرو-دنك 500 مجم كبسولات",idx,true),undefined);
});
test("distinct administration routes stay separate",()=>{
 const idx=buildImageAttributeIndex([{id:1,name:"ديكساتوب 0.1% قطرة الأذن"},{id:2,name:"ديكساتوب 0.1% قطرة العين"}],true);
 assert.equal(matchImageAttributes("ديكساتوب 0.1% للعين قطرة",idx,true)?.id,2);
 assert.equal(matchImageAttributes("ديكساتوب 0.1% قطرة",idx,true),undefined);
});
test("one explicit pack match can resolve unspecified packaging, not contradictory variants",()=>{
 const idx=buildImageAttributeIndex([{id:1,name:"دواء 100 مجم 10 اقراص"},{id:2,name:"دواء 100 مجم اقراص"},{id:3,name:"دواء 100 مجم 20 اقراص"}],true);
 assert.equal(matchImageAttributes("دواء 100 مجم 10 حبوب",idx,true)?.id,1);
 assert.equal(matchImageAttributes("دواء 100 مجم حبوب",idx,true),null);
});
