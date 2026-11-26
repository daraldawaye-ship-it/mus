import assert from "node:assert/strict";
import {test} from "node:test";
import {easyImageCardIndex,easyImageMatch,easyImageNameKey,imageNameMatchSchema} from "../apps/api/src/market-image-name-match.ts";
test("only superficial spelling and notation changes collapse",()=>{
 const key=easyImageNameKey("أكتين-بلاس ٢٥٠ملغ حبوب");
 assert.equal(key,easyImageNameKey("اكتين بلاس 250 مجم أقراص"));
 for(const x of ["اكتين بلاس 500 مجم أقراص","اكتين بلاس 250 مل أقراص","اكتين بلاس 250 مجم كبسولات","اكتين بلاس 250 مجم أقراص ممتد","اكتين بلاس 250 مجم أقراص 30 حبة","اكتين بلاس 250/5 مجم أقراص"])
   assert.notEqual(key,easyImageNameKey(x));
});
test("ambiguous products and names without strength and presentation remain unresolved",()=>{
 const a={id:1,name:"أموكسيدار 250 مجم كبسولات"};
 const b={id:2,name:"اموكسيدار 250 ملغ كبسولات"};
 assert.equal(easyImageMatch("اموكسيدار ٢٥٠ ملغ كبسولات",easyImageCardIndex([a]))?.id,1);
 assert.equal(easyImageMatch(a.name,easyImageCardIndex([a,b])),null);
 assert.equal(easyImageMatch("أموكسيدار",easyImageCardIndex([a])),undefined);
 assert.equal(easyImageMatch("أموكسيدار 250 مجم",easyImageCardIndex([a])),undefined);
});
test("preview is non-writing by default and requires a fixed unique source set",()=>{
 assert.equal(imageNameMatchSchema.parse({sourceIds:[44]}).expectedPreview,undefined);
 assert.equal(imageNameMatchSchema.safeParse({sourceIds:[44,44]}).success,false);
 assert.equal(imageNameMatchSchema.safeParse({sourceIds:[44],expectedPreview:"anything"}).success,false);
});
