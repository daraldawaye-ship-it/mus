import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { moneyString, moneyUnits } from "./finance.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";
import { audit } from "./audit.ts";
import { receiptExtraVoucherSchema, postReceiptExtraVoucher } from "./receipt-extra-voucher.ts";

const signedAmount = z.string().trim()
  .regex(/^-?(?:0|[1-9][0-9]{0,19})(?:\\.[0-9]{1,2})?$/,
    "أدخل المبلغ الفعلي بالريال اليمني حتى منزلتين عشريتين");
const common = {
  sourceOperationId: z.number().int().positive(),
  notes: z.string().trim().max(1000),
  idempotencyKey: z.string().uuid(),
};
export const pouchReceiptSchema = z.discriminatedUnion("mode", [
  z.object({ ...common, mode: z.literal("exact"),voucher:receiptExtraVoucherSchema.optional() }).strict(),
  z.object({ ...common, mode: z.literal("difference"),
    receivedAmount: signedAmount }).strict(),
]);
export type PouchReceiptInput = z.output<typeof pouchReceiptSchema>;

const conflict = (code:string, message:string): never => {
  throw new HttpError(409, code, message);
};
function line(accountId:number, signed:bigint, description:string) {
  return {accountId, debit:signed>0n?moneyString(signed):"0",
    credit:signed<0n?moneyString(-signed):"0", description};
}

export async function listPouchReceipts(
  client: PoolClient, companyId: number, status:"all"|"pending"|"received",
  limit: number, offset: number,
) {
  const filter = status==="pending"?" AND r.id IS NULL":
    status==="received"?" AND r.id IS NOT NULL":"";
  const base = `FROM employee_cashbox_operations o
      JOIN employees e ON e.company_id=o.company_id AND e.id=o.employee_id
      JOIN accounts a ON a.company_id=o.company_id AND a.id=o.destination_account_id
      LEFT JOIN employee_pouch_receipts r ON r.company_id=o.company_id
        AND r.source_operation_id=o.id
    WHERE o.company_id=$1 AND
      (o.kind='pouch' OR (o.kind='close' AND o.amount<>0))
      ${filter}`;
  const count = await client.query(`SELECT count(*)::int AS total ${base}`,
    [companyId]);
  const rows=await client.query(
    `SELECT o.id, o.kind,o.employee_name AS "employeeName",
       o.amount::text AS amount,o.notes,o.created_at AS "createdAt",
       o.financial_document_id AS "sourceDocumentId",
       a.name AS "pouchName",
       r.id AS "receiptId",r.mode AS "receiptMode",
       r.voucher_document_id AS "voucherDocumentId",
       r.received_amount::text AS "receivedAmount",
       r.difference_amount::text AS "differenceAmount",
       r.receiver_employee_name AS "receiverName",
       r.financial_document_id AS "receiptDocumentId",
       r.notes AS "receiptNotes",r.created_at AS "receivedAt"
     ${base}
     ORDER BY o.created_at DESC,o.id DESC LIMIT $2 OFFSET $3`,
    [companyId,limit,offset],
  );
  return {items:rows.rows,total:count.rows[0].total as number,
    page: Math.floor(offset/limit)+1,pageSize:limit};
}

export async function receivePouchMovement(
  client:PoolClient, companyId:number,user:User,input:PouchReceiptInput,
) {
  // Company-level FOR UPDATE lock from mutateMaster serializes submission.
  // Repeated requests with the identical UUID return the same posted record.
  const payload=JSON.stringify(input);
  const retry=await client.query(
    `SELECT id,source_operation_id AS "sourceId",financial_document_id AS "documentId",
        voucher_document_id AS "voucherDocumentId",
        expected_amount::text AS expected,received_amount::text AS received,
        difference_amount::text AS difference,request_payload=$3::jsonb AS same
      FROM employee_pouch_receipts
      WHERE company_id=$1 AND idempotency_key=$2`,
    [companyId,input.idempotencyKey,payload],
  );
  if(retry.rows[0]) {
    if (!retry.rows[0].same) conflict("receipt_key_conflict",
      "المفتاح مستخدم لاستلام مختلف؛ افتح قائمة الترحيلات وحدّثها");
    const row=retry.rows[0];
    return {id:row.id,sourceId:row.sourceId,documentId:row.documentId,
      voucherDocumentId:row.voucherDocumentId,
      expected:moneyString(moneyUnits(row.expected)),
      received:moneyString(moneyUnits(row.received)),
      difference:moneyString(moneyUnits(row.difference))};
  }
  const origin=(await client.query(
    `SELECT o.id,o.kind,o.employee_id,o.amount::text AS amount,
       o.destination_account_id AS pouch_id,o.financial_document_id
     FROM employee_cashbox_operations o
     WHERE o.company_id=$1 AND o.id=$2 FOR UPDATE`,
    [companyId,input.sourceOperationId],
  )).rows[0];
  if (!origin || !["pouch","close"].includes(origin.kind) ||
    origin.amount==="0.000000" || origin.amount==="0")
    conflict("pouch_movement_missing","حركة الحافظة غير موجودة أو لا تحتوي على مبلغ قابل للاستلام");
  const already=await client.query(
    `SELECT id FROM employee_pouch_receipts
       WHERE company_id=$1 AND source_operation_id=$2`,
    [companyId,input.sourceOperationId],
  );
  if (already.rowCount) conflict("pouch_already_received",
    "تم استلام هذه الحركة سابقًا؛ لا يمكن ترحيل استلام آخر لها");

  const receiver=(await client.query(
    `SELECT e.id,e.name,a.id AS cash_id
       FROM employees e
       JOIN employee_account_links l ON l.company_id=e.company_id
         AND l.employee_id=e.id AND l.account_kind='sales_cash'
       JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
     WHERE e.company_id=$1 AND e.user_id=$2 AND e.active
       AND a.active AND a.category='asset' AND a.kind='posting'
       AND a.cash_or_bank
     FOR SHARE OF e,a`,[companyId,user.id],
  )).rows[0];
  if (!receiver) conflict("receiver_cashbox_missing",
    "لا يوجد صندوق مبيعات فعّال مرتبط بالموظف المستلم");

  const pouch=(await client.query(
    `SELECT id,active,category,kind FROM accounts
      WHERE company_id=$1 AND id=$2`,[companyId,origin.pouch_id],
  )).rows[0];
  if (!pouch || !pouch.active || pouch.kind!=="posting" ||
      pouch.category!=="asset" || pouch.id===receiver.cash_id)
    conflict("pouch_account_missing","حساب الحافظة غير فعّال أو مطابق لصندوق المستلم");

  const original=moneyUnits(origin.amount);
  const actual=input.mode==="exact"?original:moneyUnits(input.receivedAmount);
  if (original===0n) conflict("empty_receipt","لا يمكن استلام حركة صفرية");
  if (actual!==0n && (actual>0n)!==(original>0n))
    conflict("receipt_direction","يجب أن تكون إشارة المبلغ المستلم بنفس اتجاه الحركة، أو صفرًا");
  const difference=original-actual;
  if(input.mode==="difference" && difference===0n)
    conflict("receipt_matching_amount","المبلغ مطابق؛ استخدم زر استلام مطابق");
  if (actual>10n**28n-1n || actual<-(10n**28n-1n) ||
      difference>10n**28n-1n || difference<-(10n**28n-1n))
    conflict("receipt_amount_limit","المبلغ أو الفرق تجاوز الحد المحاسبي المدعوم");

  let varianceAccount:number|null=null;
  if(difference!==0n) {
    const variance=(await client.query(
      `SELECT a.id,a.kind,a.active,a.category FROM account_links l
       JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
       WHERE l.company_id=$1 AND l.purpose='cashVariance'`,
      [companyId],
    )).rows[0];
    if(!variance || !variance.active || variance.kind!=="posting" ||
      variance.category!=="expense" ||
      [pouch.id,receiver.cash_id].includes(variance.id))
      conflict("receipt_variance_account","لم يتم ربط حساب عجز وزيادة الصناديق بصورة صحيحة");
    varianceAccount=variance.id;
  }

  const currency=(await client.query(
    `SELECT c.id,c.active,c.code FROM finance_settings f
       JOIN company_currencies c
       ON c.company_id=f.company_id AND c.id=f.base_currency_id
     WHERE f.company_id=$1`,[companyId],
  )).rows[0];
  if(!currency?.active || currency.code!=="YER")
    conflict("receipt_currency","استلام الحوافظ متاح للشركات ذات العملة الأساسية ريال يمني فقط");
  const memo=`استلام حركة الحافظة #${origin.id} — ${receiver.name} — ${input.mode==="exact"?"مطابق":"غير مطابق"}${input.notes?" — "+input.notes:""}`;
  // Debit receiver cash at actual amount; credit source pouch at expected
  // movement amount; debit variance for the expected-minus-actual difference.
  // This holds even when source movement is negative or actual count is zero.
  const lines=[];
  if(actual!==0n)lines.push(line(receiver.cash_id,actual,memo));
  lines.push(line(pouch.id,-original,memo));
  if(difference!==0n)lines.push(line(varianceAccount!,difference,memo));
  const date=(await client.query(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS date",
  )).rows[0].date as string;
  const documentId=await postCommerceJournal(client,companyId,user,{
    documentDate:date,branchId:null,currencyId:currency.id,
    description:memo.slice(0,1000),idempotencyKey:randomUUID(),lines,
  });
  const voucherDocumentId=input.mode==="exact" && input.voucher
    ? await postReceiptExtraVoucher(client,companyId,user,{
        sourceId:origin.id,sourceKind:"pouch",actualAmount:actual,
        cashAccountId:receiver.cash_id,currencyId:currency.id,documentDate:date,
        voucher:input.voucher,
      })
    : null;
  if(input.mode==="exact" && input.voucher && origin.kind==="close")
    throw new HttpError(400,"close_voucher_not_allowed",
      "إغلاق الصندوق يُستلم كالسابق دون سند مرافق");
  const saved=await client.query(
    `INSERT INTO employee_pouch_receipts(
       company_id,source_operation_id,source_employee_id,
       receiver_employee_id,receiver_employee_name,mode,
       expected_amount,received_amount,difference_amount,
       cash_account_id,pouch_account_id,variance_account_id,
       financial_document_id,voucher_document_id,notes,idempotency_key,request_payload,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING id`,
    [companyId,origin.id,origin.employee_id,receiver.id,receiver.name,input.mode,
      moneyString(original),moneyString(actual),moneyString(difference),
      receiver.cash_id,pouch.id,varianceAccount,documentId,voucherDocumentId,input.notes,
      input.idempotencyKey,payload,user.id],
  );
  const receiptId=saved.rows[0].id as number;
  await audit(client,user,"pouch.received","pouch-receipt",receiptId,null,
    {sourceOperationId:origin.id,sourceDocumentId:origin.financial_document_id,
      employeeId:receiver.id,mode:input.mode,
      expected:moneyString(original),received:moneyString(actual),
      difference:moneyString(difference),
      receiptDocumentId:documentId,voucherDocumentId,notes:input.notes},companyId);
  return {id:receiptId,sourceId:origin.id,documentId,voucherDocumentId,
    expected:moneyString(original),received:moneyString(actual),
    difference:moneyString(difference)};
}
