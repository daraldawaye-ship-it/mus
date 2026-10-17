import assert from "node:assert/strict";
import test from "node:test";
import { saleClearanceRate } from "../apps/web/src/invoice-clearance-label.ts";

const item = {
  active: true,
  commissionRate: "5.0000",
  clearanceFrom: "2026-10-10",
  clearanceTo: "2026-10-19",
};

test("sales item search shows clearance percentage for both inclusive invoice date boundaries", () => {
  assert.equal(saleClearanceRate(item, "2026-10-10"), "5");
  assert.equal(saleClearanceRate(item, "2026-10-17"), "5");
  assert.equal(saleClearanceRate(item, "2026-10-19"), "5");
  assert.equal(saleClearanceRate(item, "2026-10-09"), null);
  assert.equal(saleClearanceRate(item, "2026-10-20"), null);
});

test("sales item search hides inactive, expired, invalid or incomplete clearance offers", () => {
  assert.equal(saleClearanceRate({...item,commissionRate:"0"}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,active:false}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,clearanceFrom:null}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,clearanceTo:null}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,commissionRate:"-1"}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,commissionRate:"NaN"}, "2026-10-17"), null);
  assert.equal(saleClearanceRate(item, ""), null);
  assert.equal(saleClearanceRate(item, "2026-10-17T00:00:00Z"), null);
  assert.equal(saleClearanceRate({...item,commissionRate:"2.5000"}, "2026-10-17"), "2.5");
});
