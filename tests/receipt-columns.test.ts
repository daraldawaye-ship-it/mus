import assert from "node:assert/strict";
import test from "node:test";
import { receiptTableColumns } from "../apps/web/src/pages/PouchReceiptsPage.tsx";

test("cash pouch receipt columns follow compact right-to-left order", () => {
  assert.deepEqual(receiptTableColumns("الحافظة"), [
    "الموظف", "المبلغ", "ملاحظات", "استلام", "جزء",
    "التاريخ", "الحافظة", "نوع الحركة", "الحالة",
  ]);
});

test("electronic wallet uses exactly the same receipt column order", () => {
  assert.deepEqual(receiptTableColumns("المحفظة الإلكترونية"), [
    "الموظف", "المبلغ", "ملاحظات", "استلام", "جزء",
    "التاريخ", "المحفظة الإلكترونية", "نوع الحركة", "الحالة",
  ]);
});
