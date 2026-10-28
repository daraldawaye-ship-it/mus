import test from "node:test";
import assert from "node:assert/strict";
import {
  eligibleDoctorReferral,
  customerRegistrationReward,
} from "../apps/api/src/services/registration-reward-eligibility.ts";

test("doctor reward grants 5-point task eligibility to registered doctors or nurses",()=>{
  assert.equal(eligibleDoctorReferral("doctor",false),true);
  assert.equal(eligibleDoctorReferral("nurse",false),true);
});
test("doctor reward excludes existing entities and existing unclassified cards",()=>{
  assert.equal(eligibleDoctorReferral("entity",false),false);
  assert.equal(eligibleDoctorReferral(null,false),false);
});
test("new unclassified doctor directory card is eligible without classification",()=>{
  assert.equal(eligibleDoctorReferral(null,true),true);
});
test("customer number only earns when linked, not for name-only text",()=>{
  assert.equal(customerRegistrationReward("",false),null);
  assert.equal(customerRegistrationReward("0001",true),"new");
  assert.equal(customerRegistrationReward("0001",false),"existing");
});
