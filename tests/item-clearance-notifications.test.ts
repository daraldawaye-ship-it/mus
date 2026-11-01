import assert from "node:assert/strict";
import test from "node:test";
import {
  adenDate,
  classifyClearanceChange,
  itemClearanceNotice,
  type ItemClearanceSettings,
} from "../apps/api/src/services/item-clearance-notices.ts";

const empty: ItemClearanceSettings = {
  commissionRate: "0", clearanceFrom: null, clearanceTo: null,
};
const included: ItemClearanceSettings = {
  commissionRate: "2", clearanceFrom: "2026-10-01", clearanceTo: "2026-12-31",
};
const later: ItemClearanceSettings = {
  commissionRate: "2", clearanceFrom: "2026-12-01", clearanceTo: "2026-12-31",
};
const today = "2026-11-01";

test("each of three fields triggers one classified event when value changes", () => {
  assert.equal(classifyClearanceChange(empty, included, today), "ITEM_CLEARANCE_ADDED");
  assert.equal(classifyClearanceChange(included, empty, today), "ITEM_CLEARANCE_REMOVED");
  assert.equal(classifyClearanceChange(included, {...included, commissionRate:"3"}, today), "ITEM_CLEARANCE_UPDATED");
  assert.equal(classifyClearanceChange(included, {...included, clearanceFrom:"2026-10-05"}, today), "ITEM_CLEARANCE_UPDATED");
  assert.equal(classifyClearanceChange(included, {...included, clearanceTo:"2026-11-30"}, today), "ITEM_CLEARANCE_UPDATED");
  assert.equal(classifyClearanceChange(included, included, today), null);
});
test("moving a configured date range into and out of the current clearance window changes event classification", () => {
  assert.equal(classifyClearanceChange(later, included, today), "ITEM_CLEARANCE_ADDED");
  assert.equal(classifyClearanceChange(included, later, today), "ITEM_CLEARANCE_REMOVED");
  assert.equal(classifyClearanceChange(later, {...later, clearanceTo:"2027-01-20"}, today), "ITEM_CLEARANCE_UPDATED");
});
test("a disabled rate is not falsely counted as active clearance", () => {
  const zeroWithDates = {...included, commissionRate:"0"};
  assert.equal(classifyClearanceChange(included, zeroWithDates, today), "ITEM_CLEARANCE_REMOVED");
  assert.equal(classifyClearanceChange(zeroWithDates, included, today), "ITEM_CLEARANCE_ADDED");
});
test("message includes user, changed values, company-scoped revision key and item card", () => {
  const entry = itemClearanceNotice(included,{...included,commissionRate:"4"},{
    id:9, name:"الصنف المختبر", code:"00019", revision:12,
  },"مصطفى المختبر",today);
  assert.equal(entry?.code,"ITEM_CLEARANCE_UPDATED");
  assert.equal(entry?.eventKey,"item:clearance:9:revision:12");
  assert.equal(entry?.subjectKey,"item:9");
  assert.match(entry?.message ?? "", /مصطفى المختبر/);
  assert.match(entry?.message ?? "", /2% ← 4%/);
});
test("company-local day remains correct at timezone boundary", () => {
  assert.equal(adenDate(new Date("2026-10-31T21:30:00.000Z")),today);
});

// Notification eligibility is independent from whether the three clearance
// settings form a currently payable sale period.
test("each independent clearance field produces a notification before the campaign is complete", () => {
  const rateOnly = {...empty, commissionRate:"5"};
  const startOnly = {...empty, clearanceFrom:"2026-11-01"};
  const endOnly = {...empty, clearanceTo:"2026-11-30"};
  for (const [before, after, label] of [
    [empty, rateOnly, "النسبة"],
    [empty, startOnly, "من"],
    [empty, endOnly, "إلى"],
    [rateOnly, {...rateOnly, clearanceFrom:"2026-11-01"}, "من"],
    [startOnly, {...startOnly, clearanceTo:"2026-11-30"}, "إلى"],
  ] as const) {
    assert.equal(classifyClearanceChange(before, after, today),"ITEM_CLEARANCE_UPDATED");
    const notice = itemClearanceNotice(before, after,
      {id:14,name:"صنف تجريبي",code:"999",revision:19},"موظف",today);
    assert.ok(notice, label);
    assert.equal(notice.code, "ITEM_CLEARANCE_UPDATED");
    assert.match(notice.message, new RegExp(label));
  }
  const activated = {...rateOnly,clearanceFrom:"2026-11-01",clearanceTo:"2026-11-30"};
  assert.equal(classifyClearanceChange(
    {...rateOnly,clearanceFrom:"2026-11-01"}, activated, today), "ITEM_CLEARANCE_ADDED");
});
