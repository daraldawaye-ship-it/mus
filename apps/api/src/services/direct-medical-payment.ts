import type { PoolClient } from "pg";
import { z } from "zod";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { administrativeCustodyTransferSchema } from "../../../../packages/contracts/src/administrative-custody.ts";
import { HttpError } from "../errors.ts";
import { insertDraft, postDraft } from "../routes-finance.ts";
import { audit } from "./audit.ts";
import { custodyMedicalBeneficiary, markCustodyMedicalSales } from "./custody-medical-expense.ts";
import { loadDocument, moneyString, moneyUnits, type DocumentFields } from "./finance.ts";

export const directMedicalPaymentSchema = administrativeCustodyTransferSchema.refine(
  value => value.expenseKind === "medical" || value.expenseKind === "slips",
  { message: "حدد نوع صرف القصاصات أو العمولة" },
);
export type DirectMedicalPaymentInput = z.output<typeof directMedicalPaymentSchema>;

function conflict(code: string, message: string): never {
  throw new HttpError(409, code, message);
}

/** Post one real payment voucher directly from the authenticated cashier's till.
 * No custody, pouch or cashbox transfer is created. All related effects commit
 * (or roll back) together, including the doctor sales cutoff and slip source.
 */
export async function postDirectMedicalPayment(
  client: PoolClient,
  companyId: number,
  employeeId: number,
  user: User,
  input: DirectMedicalPaymentInput,
) {
  // Serialize with slip receipts and other direct cashier postings. This
  // protects the pending physical count and the UUID retry from concurrency.
  await client.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [companyId]);
  const previous = await client.query(
    `SELECT id,financial_document_id,created_by,request_payload=$3::jsonb AS same_payload
       FROM direct_medical_payments WHERE company_id=$1 AND idempotency_key=$2`,
    [companyId, input.idempotencyKey, JSON.stringify(input)],
  );
  if (previous.rows[0]) {
    if (previous.rows[0].created_by !== user.id || !previous.rows[0].same_payload)
      conflict("direct_payment_key_conflict", "مفتاح الطلب مستخدم لسند آخر");
    return {
      operationId: previous.rows[0].id as number,
      documentId: previous.rows[0].financial_document_id as number,
      document: await loadDocument(client, companyId, previous.rows[0].financial_document_id),
    };
  }

  const kind = input.expenseKind;
  if (kind !== "medical" && kind !== "slips")
    throw new HttpError(400, "direct_payment_kind_invalid", "حدد نوع الصرف");
  const amount = moneyUnits(input.amount);
  if (amount <= 0n || amount > 10n ** 28n - 1n)
    throw new HttpError(400, "direct_payment_amount_invalid", "أدخل مبلغ صرف موجبًا ضمن الحدود المسموحة");
  const beneficiary = await custodyMedicalBeneficiary(client, companyId, input);
  if (!beneficiary) throw new HttpError(400, "direct_payment_beneficiary_missing", "اختر الطبيب أو الممرض");

  // No account IDs supplied by the browser are trusted.
  const cashbox = (await client.query(
    `SELECT a.id,a.code,a.name FROM employee_account_links l
     JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
     WHERE l.company_id=$1 AND l.employee_id=$2 AND l.account_kind='sales_cash'
       AND a.kind='posting' AND a.active=true AND a.cash_or_bank=true LIMIT 1`,
    [companyId, employeeId],
  )).rows[0];
  if (!cashbox)
    conflict("direct_payment_cashbox_missing", "لا يوجد حساب صندوق مبيعات فعّال مربوط بأمين الصندوق");
  const linkPurpose = kind === "slips" ? "medicalSlipsExpense" : "medicalCommissionExpense";
  const expense = (await client.query(
    `SELECT a.id,a.code,a.name FROM account_links l
     JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
     WHERE l.company_id=$1 AND l.purpose=$2 AND a.kind='posting' AND a.category='expense'
       AND a.active=true LIMIT 1`,
    [companyId, linkPurpose],
  )).rows[0];
  if (!expense)
    conflict("direct_payment_expense_missing", "اربط حساب القصاصات أو عمولات الأطباء والممرضين من ربط الحسابات النظامية أولًا");
  const currency = (await client.query(
    `SELECT c.id,c.code,c.active FROM finance_settings f
     JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id
     WHERE f.company_id=$1`,
    [companyId],
  )).rows[0];
  if (!currency?.active || currency.code !== "YER")
    conflict("direct_payment_currency", "الصرف المباشر يتطلب الريال اليمني عملةً أساسية");

  const purpose = kind === "slips"
    ? `صرف قصاصات للممرض ${beneficiary.name} — عدد القصاصات: ${input.slipCount}`
    : `عمولة ${beneficiary.kind === "doctor" ? "الطبيب" : "الممرض"} ${beneficiary.name}`;
  const memo = (purpose + (input.notes ? " — " + input.notes : "")).slice(0, 1000);
  const amountText = moneyString(amount);
  // Medical sales are classified only after an actual posted payment; the
  // marker and the voucher share this database transaction.
  const marking = await markCustodyMedicalSales(client, companyId, user.id, beneficiary, kind);
  const fields: DocumentFields = {
    kind: "payment",
    documentDate: (await client.query(
      "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS date",
    )).rows[0].date as string,
    currencyId: currency.id as number,
    branchId: null,
    cashAccountId: cashbox.id as number,
    supplierReceiptNumber: "",
    description: memo,
    lines: [
      { accountId: cashbox.id, debit: "0", credit: amountText, description: memo.slice(0,500) },
      { accountId: expense.id, debit: amountText, credit: "0", description: memo.slice(0,500) },
    ],
  };
  const documentId = await insertDraft(client, companyId, user, fields,
    input.idempotencyKey, { operation: "directMedicalPayment", ...input });
  await postDraft(client, companyId, documentId, user);
  const inserted = await client.query(
    `INSERT INTO direct_medical_payments
       (company_id,cashbox_account_id,expense_account_id,amount,notes,financial_document_id,
        expense_kind,doctor_id,doctor_name,doctor_main_name,doctor_kind,slip_count,
        accounted_cutoff_invoice_id,accounted_invoice_count,idempotency_key,request_payload,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [companyId,cashbox.id,expense.id,amountText,input.notes,documentId,kind,beneficiary.id,
      beneficiary.name,beneficiary.mainName,beneficiary.kind,input.slipCount ?? null,
      marking.cutoffInvoiceId,marking.newlyMarked,input.idempotencyKey,JSON.stringify(input),user.id],
  );
  const operationId = inserted.rows[0].id as number;
  const document = await loadDocument(client, companyId, documentId);
  await audit(client,user,"financialDocument.post","financialDocument",documentId,
    null,document,companyId);
  await audit(client,user,"directMedicalPayment.post","direct-medical-payment",operationId,
    null,{documentId,kind,amount:amountText,cashboxAccountId:cashbox.id,
      expenseAccountId:expense.id,doctorId:beneficiary.id,doctorName:beneficiary.name,
      mainName:beneficiary.mainName,slipCount:input.slipCount ?? null,...marking},companyId);
  if (marking.cutoffInvoiceId !== null)
    await audit(client,user,"doctor.sales.accounted","invoice",marking.cutoffInvoiceId,
      null,{...marking,kind:beneficiary.kind,mainName:beneficiary.mainName,
        source:"direct_cashbox_medical_payment",operationId,documentId},companyId);
  return { operationId, documentId, document };
}
