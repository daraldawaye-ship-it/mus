import assert from "node:assert/strict";
import { test } from "node:test";
import { buildImageAttributeIndex, imageClinicalAttributes, matchImageAttributes } from "../apps/api/src/market-image-attributes.ts";
test("brand, explicit strength, and form can appear in different orders",()=>{
 const index=buildImageAttributeIndex([{id:10,name:"ليفوتا 250 ملج 10 اقراص"}]);
 assert.equal(matchImageAttributes("ليفوتا أقراص ٢٥٠ مجم",index)?.id,10);
 for(const title of ["ليفوتا 500 مجم أقراص","ليفوتا 250 مجم كبسول","ليفوتاب 250 مجم أقراص","ليفوتا 250 مجم أقراص ممتد","ليفوتا 250 مجم 30 أقراص"])
   assert.equal(matchImageAttributes(title,index),undefined);
});
test("unit equivalence preserves concentration, dosage form, and package conflicts",()=>{
 const idx=buildImageAttributeIndex([{id:10,name:"أكتين 100 مل معلق 250 ملغ/5 مل"},{id:11,name:"دواء 1 جم فيال"}]);
 assert.equal(matchImageAttributes("أكتين معلق 50 مجم/مل 100 مل",idx)?.id,10);
 assert.equal(matchImageAttributes("أكتين شراب 250 مجم/5مل 100 مل",idx),undefined);
 assert.equal(matchImageAttributes("أكتين معلق 250 مجم/5مل 60 مل",idx),undefined);
 assert.equal(matchImageAttributes("دواء فيال 1000 مجم",idx)?.id,11);
 assert.equal(matchImageAttributes("دواء أمبول 1000 مجم",idx),undefined);
 assert.equal(imageClinicalAttributes("دواء كريم 30 جم"),undefined);
 assert.equal(imageClinicalAttributes("دواء شراب 100 مل"),undefined);
});
test("identical clinical identity in multiple packs does not choose without a count",()=>{
 const idx=buildImageAttributeIndex([{id:10,name:"زيبيد 3 ملج 3×10 اقراص"},{id:11,name:"زيبيد 3 ملج 100 اقراص"}]);
 assert.equal(matchImageAttributes("زيبيد 3 مجم حبوب",idx),null);
 assert.equal(matchImageAttributes("زيبيد 3 مجم 100 حبوب",idx)?.id,11);
});
