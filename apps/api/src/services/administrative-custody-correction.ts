import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import type { AdministrativeCustodyTransferInput } from "../../../../packages/contracts/src/administrative-custody.ts";
import { HttpError } from "../errors.ts";
import { audit } from "./audit.ts";
import { checkPendingReceipts } from "./cashbox-notifications.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";
import { moneyString, moneyUnits } from "./finance.ts";

const eligible = `t.expense_kind='medical' AND t.amount>0 AND t.accounted_invoice_count=0
  AND f.status='posted' AND f.kind='journal' AND f.currency_code='YER'
  AND f.reversal_document_id IS NULL AND f.reverses_document_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM administrative_custody_receipts r
    WHERE r.company_id=t.company_id AND r.source_transfer_id=t.id)
  AND NOT EXISTS (SELECT 1 FROM administrative_custody_medical_corrections c
    WHERE c.company_id=t.company_id AND c.source_transfer_id=t.id)`;

export const custodyCorrectionCandidatesSql = `SELECT t.id, f.number AS "documentNumber",
  t.amount::text AS amount, t.notes, t.created_at AS "createdAt"
  FROM administrative_custody_transfers t
  JOIN financial_documents f ON f.company_id=t.company_id AND f.id=t.financial_document_id
  WHERE t.company_id=$1 AND t.doctor_id=$2 AND ${eligible}
  ORDER BY t.created_at DESC,t.id DESC LIMIT 100`;

export async function listCustodyMedicalCorrectionCandidates(client: PoolClient, companyId: number, doctorId: number) {
  const { rows } = await client.query(custodyCorrectionCandidatesSql, [companyId, doctorId]);
  return rows;
}

export function custodyMedicalCorrectionLines(
  custodyId: number, pouchId: number, amount: bigint, description: string,
) {
  const total = moneyString(amount);
  return [
    { accountId: custodyId, debit: total, credit: "0", description },
    { accountId: pouchId, debit: "0", credit: total, description },
  ];
}

/** Call under the company transaction and custody UUID lock shared by regular posting. */
export async function postCustodyMedicalCorrection(
  client: PoolClient, companyId: number, user: User, input: AdministrativeCustodyTransferInput,
) {
  const sourceId = input.correctionSourceId;
  const amount = -moneyUnits(input.amount);
  if (input.expenseKind !== "medical" || !sourceId || !input.doctorId || !input.notes.trim() || amount <= 0n)
    throw new HttpError(400, "custody_correction_invalid", "حدد الصرف المكرر واكتب سبب تصحيحه.");
  // First lock the same source row as pouch receiving. Run eligibility in a new
  // statement after acquiring the lock to observe a concurrent receipt/correction.
  await client.query("SELECT id FROM administrative_custody_transfers WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [companyId, sourceId]);
  const { rows } = await client.query(`SELECT t.custody_account_id, t.pouch_account_id,
      t.financial_document_id, t.amount::text, f.number, f.currency_id
    FROM administrative_custody_transfers t
    JOIN financial_documents f ON f.company_id=t.company_id AND f.id=t.financial_document_id
    JOIN finance_settings fs ON fs.company_id=t.company_id AND fs.base_currency_id=f.currency_id
    WHERE t.company_id=$1 AND t.id=$2 AND t.doctor_id=$3 AND t.amount=$4::numeric
      AND ${eligible}`, [companyId, sourceId, input.doctorId, moneyString(amount)]);
  const source = rows[0];
  if (!source) throw new HttpError(409, "custody_correction_unavailable",
    "الحركة لم تعد قابلة للتصحيح: تحقق من المستفيد والمبلغ وحالة الاستلام ومحاسبة المبيعات.");
  const originalLines = await client.query<{account_id: number; debit: string; credit: string}>(`
    SELECT account_id,debit::text,credit::text FROM financial_document_lines
    WHERE company_id=$1 AND document_id=$2`, [companyId, source.financial_document_id]);
  if (originalLines.rows.length !== 2 || !originalLines.rows.some(line =>
    line.account_id === source.custody_account_id && moneyUnits(line.debit) === 0n && moneyUnits(line.credit) === amount)
    || !originalLines.rows.some(line =>
      line.account_id === source.pouch_account_id && moneyUnits(line.debit) === amount && moneyUnits(line.credit) === 0n))
    throw new HttpError(409, "custody_correction_journal_mismatch", "قيد الصرف الأصلي لا يطابق حركة العهدة.");
  const memo = (`تصحيح صرف مكرر للعهدة — القيد الأصلي ${source.number} — ` + input.notes).slice(0, 500);
  const date = await client.query<{date: string}>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS date");
  const documentId = await postCommerceJournal(client, companyId, user, {
    documentDate: date.rows[0]!.date, branchId: null, currencyId: source.currency_id,
    description: memo, idempotencyKey: randomUUID(),
    lines: custodyMedicalCorrectionLines(source.custody_account_id, source.pouch_account_id, amount, memo),
  });
  await client.query(`INSERT INTO administrative_custody_medical_corrections
    (company_id,source_transfer_id,financial_document_id,idempotency_key,request_payload,created_by)
    VALUES($1,$2,$3,$4,$5,$6)`, [companyId, sourceId, documentId, input.idempotencyKey, JSON.stringify(input), user.id]);
  await audit(client, user, "administrativeCustody.transfer", "administrative-custody-transfer",
    sourceId, null, { correctionKind: "medicalDuplicate", sourceDocumentId: source.financial_document_id, reversalDocumentId: documentId,
      amount: moneyString(amount), doctorId: input.doctorId, notes: input.notes }, companyId);
  await checkPendingReceipts(client, companyId, "pouch", "custody-medical-correction:" + sourceId, true);
  return { operationId: sourceId, documentId };
}
