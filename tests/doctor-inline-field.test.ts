import test from "node:test";
import assert from "node:assert/strict";
import {
  doctorInlinePatchSchema, effectiveDoctorSharedName, isMainDoctorCard,
} from "../packages/contracts/src/doctors.ts";

const base={revision:3};
test("doctor directory inline edits accept each editable field",()=>{
  const valid=[
    {field:"sharedName",value:"قسم الولادة"},
    {field:"kind",value:"doctor"},
    {field:"kind",value:null},
    {field:"department",value:"الجمهوري"},
    {field:"phone",value:"777123456"},
    {field:"searchKeys",value:"الولادة"},
    {field:"notes",value:"متابعة"},
    {field:"active",value:false},
  ];
  for(const item of valid){
    assert.equal(doctorInlinePatchSchema.safeParse({...base,...item}).success,true,item.field);
  }
});
test("doctor inline edits reject invalid types, stale/missing revisions and name edits",()=>{
  const invalid=[
    {field:"name",value:"تغيير الاسم"},
    {field:"sharedName",value:"x".repeat(241)},
    {field:"notes",value:"x".repeat(2001)},
    {field:"active",value:"false"},
    {field:"kind",value:"unknown"},
    {field:"phone",value:"x".repeat(61)},
    {field:"department",value:42},
    {field:"kind",value:"entity",revision:0},
  ];
  for(const item of invalid)
    assert.equal(doctorInlinePatchSchema.safeParse({...base,...item}).success,false,item.field);
});
test("shared name identifies main card but does not rewrite child name",()=>{
  assert.equal(effectiveDoctorSharedName("قسم الولادة",""),"قسم الولادة");
  assert.equal(isMainDoctorCard("قسم الولادة","قسم الولادة"),true);
  assert.equal(isMainDoctorCard("ولادة","قسم الولادة"),false);
});
