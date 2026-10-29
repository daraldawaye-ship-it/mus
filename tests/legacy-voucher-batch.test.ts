import assert from "node:assert/strict";
import { test } from "node:test";
import { batchSchema } from "../apps/api/src/routes-transaction-import-schemas.ts";
import { prepareRawVoucher } from "../apps/api/src/services/legacy-voucher-batch.ts";

const sample = {
  source_id: "3135302",
  source_row_number: 120,
  posting_date: "2024-09-04",
  source_created_at: "2024-09-04T01:45:41+03:00",
  source_payload: {
    "معرف_حركة_السندات_م": "3135302",
    "رقم_السند": "240904014541643",
    "المنشى_بدون_تعديل_للسندات": "علي ابوطالب",
    "نوع_السند": "سند صرف",
    "ملاحظات_السند": "الدفعة القديمة",
  },
  cash_id: 400,
  other_id: 2241,
  amount: "30000",
  receipt: false,
};
test("preserve raw identity and date and balance historical payment", () => {
  const doc = prepareRawVoucher(sample, 7, 2);
  assert.equal(doc.sourceId, "3135302");
  assert.equal(doc.payload.documentDate, "2024-09-04");
  assert.equal(doc.payload.kind, "payment");
  assert.deepEqual(doc.payload.lines, [
    { accountId: 400, debit: "0", credit: "30000" },
    { accountId: 2241, debit: "30000", credit: "0" },
  ]);
  assert.equal((doc.sourceRows[0] as Record<string, string>)["رقم_السند"], sample.source_payload["رقم_السند"]);
  assert.equal(doc.sourceRows[0]["__excel_row"], "120");
  assert.deepEqual(doc, prepareRawVoucher(sample, 7, 2));
  assert.equal(batchSchema.safeParse({
    idempotencyKey: "aa111111-1111-8111-8111-111111111111",
    sourceSystem: "dar-aldawa-legacy-2026-10",
    postingDate: "2026-10-29",
    preserveDocumentDates: true,
    documents: [doc],
  }).success, true);
});
test("receipt debits the cashbox and credits the counterparty", () => {
  const doc = prepareRawVoucher({ ...sample, receipt: true, source_id: "3135304" }, 7, 2);
  assert.equal(doc.payload.kind, "receipt");
  assert.deepEqual(doc.payload.lines, [
    { accountId: 400, debit: "30000", credit: "0" },
    { accountId: 2241, debit: "0", credit: "30000" },
  ]);
  assert.notEqual(doc.payload.idempotencyKey, prepareRawVoucher(sample, 7, 2).payload.idempotencyKey);
});
