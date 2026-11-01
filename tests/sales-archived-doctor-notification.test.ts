import test from "node:test";
import assert from "node:assert/strict";
import { archivedDoctorSaleNotice } from "../apps/api/src/services/sales-doctor-notification.ts";

test("archived doctor usage links to the existing card and identifies its invoice", () => {
  const result = archivedDoctorSaleNotice(2, { id: 78, name: "جهة مؤرشفة" }, 101, "0000000101");
  assert.equal(result.code, "SALES_ARCHIVED_DOCTOR_USED");
  assert.equal(result.href, "/companies/2/doctors?focus=78");
  assert.match(result.message, /جهة مؤرشفة/);
  assert.match(result.message, /0000000101/);
  assert.match(result.message, /لم يُنشأ كرت مكرر/);
});

test("each sale gets a distinct notice, including repeated use of one archived doctor", () => {
  const doctor = { id: 78, name: "جهة مؤرشفة" };
  const first = archivedDoctorSaleNotice(2, doctor, 101, "101");
  const second = archivedDoctorSaleNotice(2, doctor, 102, "102");
  assert.notEqual(first.eventKey, second.eventKey);
  assert.notEqual(first.subjectKey, second.subjectKey);
  assert.equal(first.href, second.href);
  assert.equal(first.eventKey, archivedDoctorSaleNotice(2, doctor, 101, "101").eventKey);
});

test("archived doctor alert identifies the user who saved the sale", () => {
  const alert = archivedDoctorSaleNotice(
    2, { id: 78, name: "جهة مؤرشفة" }, 101, "0000000101", "الموظف المختبر",
  );
  assert.match(alert.message, /منشئ الفاتورة: الموظف المختبر/);
});
