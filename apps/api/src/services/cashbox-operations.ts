import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { moneyString, moneyUnits } from "./finance.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";
import { audit } from "./audit.ts";

export const cashboxOperationSchema = z.object({
  kind: z.enum(["pouch", "electronic", "close"]),
  amount: z.string().trim().regex(/^-?(?:0|[1-9][0-9]{0,19})(?:\\.[0-9]{1,2})?$/,
    "أدخل مبلغًا بالريال اليمني (حتى منزلتين عشريتين)"),
  notes: z.string().trim().max(1000),
  idempotencyKey: z.string().uuid(),
}).strict();

export type CashboxOperationInput = z.output<typeof cashboxOperationSchema>;
const error = (code: string, description: string): never => {
  throw new HttpError(409, code, description);
};
async function balance(db: PoolClient, companyId: number, accountId: number): Promise<bigint> {
  const result = await db.query(
    `SELECT COALESCE(sum(l.base_debit-l.base_credit),0)::text AS amount
     FROM financial_document_lines l
     JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id
     WHERE l.company_id=$1 AND l.account_id=$2 AND d.status<>'draft'`,
    [companyId, accountId],
  );
  return moneyUnits(result.rows[0].amount);
}
function journalLine(accountId: number, signed: bigint, description: string) {
  return {
    accountId, debit: signed>0n?moneyString(signed):"0",
    credit: signed<0n?moneyString(-signed):"0", description,
  };
}
export async function postEmployeeCashboxOperation(
  client: PoolClient, companyId: number, user: User,
  input: CashboxOperationInput,
) {
  // The company lock taken by mutateMaster serializes the till with other
  // finance/commerce mutations and protects its book balance.
  const previous = await client.query(
    "SELECT *,request_payload=$3::jsonb AS same_payload FROM employee_cashbox_operations WHERE company_id=$1 AND idempotency_key=$2",
    [companyId, input.idempotencyKey,JSON.stringify(input)],
  );
  if (previous.rows[0]) {
    const p=previous.rows[0];
    if (p.created_by!==user.id || !p.same_payload)
      error("cashbox_key_conflict","مفتاح هذه العملية مستخدم بالفعل لبيانات مختلفة");
    return { operationId:p.id, documentId:p.financial_document_id,
      bookBalance:p.book_balance === null?null:moneyString(moneyUnits(p.book_balance)),
      difference:p.variance_amount===null?null:moneyString(moneyUnits(p.variance_amount)) };
  }
  const employee = (await client.query(
    `SELECT id,name FROM employees WHERE company_id=$1 AND user_id=$2 AND active
     FOR SHARE`,[companyId,user.id],
  )).rows[0];
  if (!employee) error("cashbox_employee_missing","لا يوجد موظف فعّال مرتبط بالمستخدم الحالي");
  const links=await client.query(
    `SELECT l.account_kind,a.id,a.name,a.kind,a.category,a.active,a.cash_or_bank
     FROM employee_account_links l
     JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
     WHERE l.company_id=$1 AND l.employee_id=$2
       AND l.account_kind IN ('sales_cash','sales_pouch')`,
    [companyId,employee.id],
  );
  const cash=links.rows.find(x=>x.account_kind==="sales_cash");
  const pouch=links.rows.find(x=>x.account_kind==="sales_pouch");
  if (!cash || !cash.active || cash.kind!=="posting" ||
      cash.category!=="asset" || !cash.cash_or_bank)
    error("cashbox_not_configured","يجب ربط صندوق مبيعات فعّال بالموظف أولًا");
  if ((input.kind==="pouch" || input.kind==="close") &&
     (!pouch || !pouch.active || pouch.kind!=="posting" ||
      pouch.category!=="asset" || pouch.id===cash.id))
    error("sales_pouch_not_configured","يجب ربط حافظة مبيعات فعّالة بالموظف");
  let destination=pouch;
  if (input.kind==="electronic") {
    destination=(await client.query(
      `SELECT a.id,a.name,a.kind,a.category,a.active
       FROM account_links l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
       WHERE l.company_id=$1 AND l.purpose='electronicWallet'`,
      [companyId],
    )).rows[0];
    if (!destination || !destination.active || destination.category!=="asset" ||
        destination.kind!=="posting" || destination.id===cash.id)
      error("electronic_wallet_not_configured",
        "عرّف حساب المحفظة الإلكترونية للشركة من الإدارة ← ربط الحسابات أولًا");
  }
  const currency=(await client.query(
    `SELECT c.id,c.code,c.active FROM finance_settings f
     JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id
     WHERE f.company_id=$1`,[companyId],
  )).rows[0];
  if (!currency?.active || currency.code!=="YER")
    error("cashbox_currency","هذه الاختصارات تتطلب ضبط الريال اليمني عملة أساسية للشركة");
  const amount=moneyUnits(input.amount);
  if (input.kind!=="close" && amount===0n)
    error("invalid_cashbox_amount","أدخل مبلغًا غير صفري");
  if (input.kind!=="pouch" && amount<0n)
    error("invalid_cashbox_amount","لا يقبل هذا الإجراء مبلغًا سالبًا");
  if (amount>10n**28n-1n || amount<-(10n**28n-1n))
    error("cashbox_amount_excess","المبلغ أكبر من الحد المسموح");
  const book=await balance(client,companyId,cash.id);
  const description = input.kind==="pouch"?"ترحيل بين صندوق البائع وحافظته":
    input.kind==="electronic"?"تحويل دفعة هاتفية إلى المحفظة الإلكترونية للشركة":
    "إغلاق صندوق المبيعات وجرد النقد الفعلي";
  const memo=`${description} — ${employee.name}${input.notes?" — "+input.notes:""}`;
  const lines: ReturnType<typeof journalLine>[]=[];
  let variance:bigint|null=null;
  let varianceAccountId:number|null=null;
  if (input.kind==="close") {
    if (book<0n) error("negative_cashbox_balance","رصيد الصندوق الدفتري سالب؛ صحّح العمليات أولًا");
    variance=book-amount;
    const found=(await client.query(
      `SELECT a.id,a.active,a.kind,a.category FROM account_links l
       JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
       WHERE l.company_id=$1 AND l.purpose='cashVariance'`,
      [companyId],
    )).rows[0];
    if (!found || !found.active || found.kind!=="posting" || found.category!=="expense" ||
      found.id===cash.id || found.id===pouch.id)
      error("variance_account_missing","يجب ربط حساب عجز وزيادة الصناديق الفعّال");
    varianceAccountId=found.id;
    // Actual count is transferred into the pouch, not the ledger balance.
    // Difference is booked to one variance account (debit shortage, credit overage).
    if (amount>0n) lines.push(journalLine(pouch.id,amount,memo));
    if (variance!==0n) lines.push(journalLine(varianceAccountId,variance,memo));
    if (book>0n) lines.push(journalLine(cash.id,-book,memo));
    if (!lines.length) error("empty_cashbox_close","الصندوق مصفّر بالفعل؛ لا يوجد مبلغ أو فرق للترحيل");
  } else {
    const source=amount>0n?cash.id:destination.id;
    const total=amount>0n?amount:-amount;
    const available=source===cash.id?book:await balance(client,companyId,source);
    if (available<total) error("insufficient_cashbox_funds",
      "المبلغ أكبر من الرصيد الدفتري المتاح للحساب المحوّل منه");
    lines.push(journalLine(source,-total,memo));
    lines.push(journalLine(amount>0n?destination.id:cash.id,total,memo));
  }
  // A two-sided/three-sided posted journal and cashbox history are atomic.
  const businessDate=(await client.query(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS date",
  )).rows[0].date as string;
  const documentId=await postCommerceJournal(client,companyId,user,{
    documentDate:businessDate,branchId:null,currencyId:currency.id,
    description:memo.slice(0,1000),idempotencyKey:randomUUID(),
    lines,
  });
  const saved=await client.query(
    `INSERT INTO employee_cashbox_operations(
       company_id,employee_id,employee_name,kind,amount,notes,
       cash_account_id,destination_account_id,variance_account_id,
       book_balance,variance_amount,financial_document_id,
       idempotency_key,request_payload,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id`,
    [companyId,employee.id,employee.name,input.kind,
      moneyString(amount),input.notes,cash.id,destination.id,varianceAccountId,
      variance===null?null:moneyString(book),
      variance===null?null:moneyString(variance),
      documentId,input.idempotencyKey,JSON.stringify(input),user.id],
  );
  const operationId=saved.rows[0].id as number;
  await audit(client,user,"cashbox.quick-post","cashbox-operation",operationId,null,
    {kind:input.kind,employeeId:employee.id,amount:moneyString(amount),
     currency:"YER",documentId,bookBalance:variance===null?null:moneyString(book),
     shortage:variance!==null&&variance>0n?moneyString(variance):"0",
     surplus:variance!==null&&variance<0n?moneyString(-variance):"0",
     notes:input.notes},companyId);
  return {operationId,documentId,bookBalance:variance===null?null:moneyString(book),
    difference:variance===null?null:moneyString(variance)};
}
