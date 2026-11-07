import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { moneyString, moneyUnits } from "./finance.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";
import { audit } from "./audit.ts";

export const administrativeCustodyFundingSchema = z.object({
  amount: z.string().trim().regex(/^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,2})?$/,
    "أدخل مبلغًا موجبًا بالريال اليمني حتى منزلتين عشريتين"),
  notes: z.string().trim().max(1000),
  idempotencyKey: z.string().uuid(),
}).strict();
export type AdministrativeCustodyFundingInput = z.output<typeof administrativeCustodyFundingSchema>;
function conflict(code: string, message: string): never {
  throw new HttpError(409, code, message);
}
export async function postAdministrativeCustodyFunding(
  client: PoolClient, companyId: number, user: User, input: AdministrativeCustodyFundingInput,
) {
  // Serialized by the company row lock; idempotent retries never double-post.
  const previous = await client.query(
    "SELECT id,financial_document_id,created_by,request_payload=$3::jsonb AS same_payload FROM administrative_custody_fundings WHERE company_id=$1 AND idempotency_key=$2",
    [companyId, input.idempotencyKey, JSON.stringify(input)],
  );
  if (previous.rows[0]) {
    if (previous.rows[0].created_by !== user.id || !previous.rows[0].same_payload)
      conflict("custody_funding_key_conflict", "مفتاح التغذية مستخدم لعملية أخرى");
    return { operationId: previous.rows[0].id as number,
      documentId: previous.rows[0].financial_document_id as number };
  }
  const amount = moneyUnits(input.amount);
  if (amount <= 0n) conflict("custody_funding_amount", "أدخل مبلغًا موجبًا لتغذية العهدة");
  if (amount > 10n ** 28n - 1n) conflict("custody_funding_overflow", "المبلغ يتجاوز الحد المدعوم");
  const employee = (await client.query(
    "SELECT id,name FROM employees WHERE company_id=$1 AND user_id=$2 AND active FOR SHARE",
    [companyId, user.id],
  )).rows[0];
  if (!employee) conflict("custody_funding_employee_missing",
    "تغذية العهدة تتطلب موظفًا فعالًا مرتبطًا بالمستخدم الحالي");
  const cash = (await client.query(
    `SELECT a.id,a.active,a.kind,a.category,a.cash_or_bank FROM employee_account_links l
     JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
     WHERE l.company_id=$1 AND l.employee_id=$2 AND l.account_kind='sales_cash'`,
    [companyId, employee.id],
  )).rows[0];
  if (!cash || !cash.active || cash.kind !== "posting" ||
      cash.category !== "asset" || !cash.cash_or_bank)
    conflict("custody_funding_cashbox_missing", "اربط صندوق مبيعات فعالًا بالموظف أولًا");
  const custody = (await client.query(
    `SELECT a.id,a.active,a.kind,a.category FROM account_links l
     JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
     WHERE l.company_id=$1 AND l.purpose='administrativeCustody'`, [companyId],
  )).rows[0];
  if (!custody || !custody.active || custody.kind !== "posting" || custody.category !== "asset")
    conflict("custody_funding_custody_missing",
      "اربط حساب العهدة الإدارية الحركي من ربط الحسابات النظامية أولًا");
  if (cash.id === custody.id)
    conflict("custody_funding_same_account", "صندوق الموظف وحساب العهدة لا يمكن أن يكونا الحساب نفسه");
  const currency = (await client.query(
    `SELECT c.id,c.code,c.active FROM finance_settings f
     JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id
     WHERE f.company_id=$1`, [companyId],
  )).rows[0];
  if (!currency?.active || currency.code !== "YER")
    conflict("custody_funding_currency", "تغذية العهدة تتطلب ضبط الريال اليمني عملة أساسية للشركة");
  const memo = (`تغذية العهدة الإدارية من صندوق ${employee.name}` +
    (input.notes ? " — " + input.notes : "")).slice(0, 1000);
  const businessDate = (await client.query(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS date",
  )).rows[0].date as string;
  const documentId = await postCommerceJournal(client, companyId, user, {
    documentDate: businessDate, branchId: null, currencyId: currency.id as number,
    description: memo, idempotencyKey: randomUUID(),
    lines: [
      {accountId: cash.id as number, debit: "0", credit: moneyString(amount), description: memo},
      {accountId: custody.id as number, debit: moneyString(amount), credit: "0", description: memo},
    ],
  });
  const row = await client.query(
    `INSERT INTO administrative_custody_fundings
     (company_id,employee_id,employee_name,cash_account_id,custody_account_id,
      amount,notes,financial_document_id,idempotency_key,request_payload,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [companyId, employee.id, employee.name, cash.id, custody.id, moneyString(amount),
      input.notes, documentId, input.idempotencyKey, JSON.stringify(input), user.id],
  );
  const operationId = row.rows[0].id as number;
  await audit(client, user, "administrativeCustody.fund", "administrative-custody-funding",
    operationId, null, {employeeId:employee.id,cashAccountId:cash.id,
      custodyAccountId:custody.id,amount:moneyString(amount),documentId,notes:input.notes},companyId);
  return { operationId, documentId };
}
