import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { batchSchema } from "../routes-transaction-import-schemas.ts";
import { importTransactionBatch } from "./transaction-import.ts";

const RAW_SOURCE = "dar-al-dawa-legacy-vouchers-2026-10-26";
const POSTED_SOURCE = "dar-aldawa-legacy-2026-10";

type RawVoucher = {
  source_id: string;
  source_row_number: number;
  posting_date: string;
  source_created_at: string;
  source_payload: Record<string, string>;
  cash_id: number;
  other_id: number;
  amount: string;
  receipt: boolean;
};

function stableUuid(parts: (string | number)[]): string {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function prepareRawVoucher(row: RawVoucher, currencyId: number, branchId: number) {
  const p = row.source_payload;
  const amount = row.amount;
  const lineCash = row.receipt
    ? { accountId: row.cash_id, debit: amount, credit: "0" }
    : { accountId: row.cash_id, debit: "0", credit: amount };
  const lineOther = row.receipt
    ? { accountId: row.other_id, debit: "0", credit: amount }
    : { accountId: row.other_id, debit: amount, credit: "0" };
  return {
    type: "voucher" as const,
    sourceId: row.source_id,
    sourceDocumentNumber: String(p["رقم_السند"]),
    sourceCreatedAt: row.source_created_at,
    sourceCreators: [String(p["المنشى_بدون_تعديل_للسندات"] || "غير معروف")],
    sourceMovementIds: [row.source_id],
    sourceRows: [{
      ...Object.fromEntries(Object.entries(p).map(([key, value]) => [key, String(value ?? "")])),
      __excel_row: String(row.source_row_number),
      __null_fields: "[]",
    }],
    payload: {
      kind: row.receipt ? "receipt" as const : "payment" as const,
      documentDate: row.posting_date,
      currencyId,
      branchId,
      cashAccountId: row.cash_id,
      supplierReceiptNumber: "",
      description: String(p["ملاحظات_السند"] || "").slice(0, 950),
      lines: [lineCash, lineOther],
      idempotencyKey: stableUuid(["alraesy-legacy-raw-voucher-v1", row.source_id]),
    },
  };
}

/** Import only linked, active, verified cashbox vouchers; leave uncertain records untouched. */
export async function postNextRawVoucherBatch(
  client: PoolClient, user: User, companyId: number,
  afterRow: number, limit: number, assertPages: () => Promise<void>,
) {
  if (companyId !== 2)
    throw new HttpError(404, "not_found", "هذا الترحيل خاص بصيدلية دار الدواء");
  // A short lock serializes the cursor selection with concurrent calls.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext(current_schema()||':raw-voucher-posting'),$1::integer)",
    [companyId],
  );
  const settings = await client.query(
    `SELECT s.base_currency_id AS currency_id
     FROM finance_settings s JOIN company_currencies c
       ON c.company_id=s.company_id AND c.id=s.base_currency_id AND c.active
     WHERE s.company_id=$1`, [companyId],
  );
  const branch = await client.query(
    "SELECT id FROM branches WHERE company_id=$1 AND id=2 AND active", [companyId],
  );
  if (!settings.rows[0] || !branch.rows[0])
    throw new HttpError(409, "invalid_reference", "العملة الأساسية أو الفرع الرئيسي غير فعال");
  const candidates = await client.query<RawVoucher>(
    `SELECT v.source_id, v.source_row_number, v.posting_date::text AS posting_date,
       v.source_payload,
       to_char(timestamp '1899-12-30' +
         round((v.source_payload->>'الانشاء_بدون_تعديل_للسندات')::numeric*86400)
         * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00' AS source_created_at,
       ac.id AS cash_id, ao.id AS other_id,
       abs((v.source_payload->>'مجموع_دائن_ومدين')::numeric)::text AS amount,
       ((v.source_payload->>'مجموع_دائن_ومدين')::numeric > 0) AS receipt
     FROM legacy_voucher_raw_import v
     JOIN legacy_account_imports c ON c.company_id=v.company_id
       AND c.source='ac333333.xlsx'
       AND c.legacy_id=(v.source_payload->>'معرف_الحساب')::integer
     JOIN legacy_account_imports o ON o.company_id=v.company_id
       AND o.source='ac333333.xlsx'
       AND o.legacy_id=(v.source_payload->>'معرف_الصندوق')::integer
     JOIN accounts ac ON ac.company_id=v.company_id AND ac.id=c.account_id
     JOIN accounts ao ON ao.company_id=v.company_id AND ao.id=o.account_id
     WHERE v.company_id=$1 AND v.source_system=$2 AND v.source_row_number>$3
       AND NOT EXISTS (
         SELECT 1 FROM transaction_source_imports s
         WHERE s.company_id=v.company_id AND s.source_system=$4
           AND s.source_kind='voucher' AND s.source_id=v.source_id
       )
       AND ac.active AND ao.active AND ac.kind='posting' AND ao.kind='posting'
       AND ac.cash_or_bank AND ac.category='asset' AND ac.id<>ao.id
       AND (v.source_payload->>'مجموع_دائن_ومدين')::numeric =
         round((v.source_payload->>'مجموع_دائن_ومدين')::numeric, 2)
       AND (
         ((v.source_payload->>'مجموع_دائن_ومدين')::numeric > 0
           AND v.source_payload->>'نوع_السند'='سند قبض')
         OR ((v.source_payload->>'مجموع_دائن_ومدين')::numeric < 0
           AND v.source_payload->>'نوع_السند'='سند صرف')
       )
     ORDER BY v.source_row_number LIMIT $5`,
    [companyId, RAW_SOURCE, afterRow, POSTED_SOURCE, limit],
  );
  if (!candidates.rows.length)
    return { afterRow, nextRow: afterRow, considered: 0, imported: 0,
      existing: 0, failed: [], hasMore: false };
  const docs = candidates.rows.map(row => prepareRawVoucher(
    row, Number(settings.rows[0].currency_id), Number(branch.rows[0].id),
  ));
  const batch = batchSchema.parse({
    idempotencyKey: stableUuid([
      "alraesy-legacy-raw-voucher-batch-v1",
      companyId, ...candidates.rows.map(row => row.source_id),
    ]),
    sourceSystem: POSTED_SOURCE,
    postingDate: candidates.rows[0]!.posting_date,
    preserveDocumentDates: true,
    documents: docs,
  });
  const saved = await importTransactionBatch(client, user, companyId, batch, assertPages);
  return {
    afterRow,
    nextRow: candidates.rows.at(-1)!.source_row_number,
    considered: candidates.rows.length,
    imported: saved.imported.length,
    existing: saved.existing.length,
    failed: saved.failed,
    hasMore: candidates.rows.length === limit,
    firstSourceId: candidates.rows[0]!.source_id,
    lastSourceId: candidates.rows.at(-1)!.source_id,
  };
}
