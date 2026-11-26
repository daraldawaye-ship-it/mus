import assert from "node:assert/strict";
import { test } from "node:test";
import {buildEnglishImageIndex,matchEnglishImageName} from "../apps/api/src/market-image-english-match.ts";
const c=(id:number,name:string,englishName:string)=>({id,name,englishName});
test("uses separately printed English and requires the declared Arabic strength and form",()=>{
 const a=buildEnglishImageIndex([c(1,"كونولول 5 ملج اقراص","Conolol 5 mg film-coated tablets"),c(2,"كونولول 10 ملج اقراص","Conolol 10 mg Tablets"),c(3,"كونولول 5 ملج كبسولات","Conolol 5 mg Capsules")]);
 assert.equal(matchEnglishImageName("Conolol","كونولول 5 مجم حبوب",a)?.id,1);
 assert.equal(matchEnglishImageName("Conolol 5 mg","كونولول 5 مجم حبوب",a)?.id,1);
 assert.equal(matchEnglishImageName("Conolol 10 mg","كونولول 5 مجم حبوب",a),undefined);
 assert.equal(matchEnglishImageName("Conolol","كونولول حبوب",a),undefined);
 assert.equal(matchEnglishImageName("Other","كونولول 5 مجم حبوب",a),undefined);
});
test("blocks pack conflicts, multiple candidates, and different release types",()=>{
 const a=buildEnglishImageIndex([c(1,"كونولول 5 ملج 30 اقراص","Conolol 5 mg 30 tablets"),c(2,"كونولول 5 ملج 20 اقراص","Conolol 5 mg 20 tablets"),c(3,"كونولول 5 ملج اقراص ممتدة","Conolol 5 mg extended-release tablets")]);
 assert.equal(matchEnglishImageName("Conolol","كونولول 5 ملج 30 أقراص",a)?.id,1);
 assert.equal(matchEnglishImageName("Conolol","كونولول 5 ملج 10 أقراص",a),undefined);
 assert.equal(matchEnglishImageName("Conolol","كونولول 5 ملج أقراص",a),null);
});
