import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { checkQuantum, moneyString, moneyUnits } from "./finance.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";
import { audit } from "./audit.ts";

const fundingFields = {
  amount: z.string().trim().regex(/^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,2})?$/,
    "أدخل مبلغًا موجبًا بالريال اليمني حتى منزلتين عشريتين"),
  countedCash: z.string().trim().regex(/^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,2})?$/,
    "أدخل المبلغ الموجود فعليًا في صندوق العهدة (صفر أو أكثر)"),
  notes: z.string().trim().max(1000),
  idempotencyKey: z.string().uuid(),
};
export const administrativeCustodyFundingSchema = z.discriminatedUnion("mode", [
  z.object({...fundingFields, mode: z.literal("preview")}).strict(),
  z.object({...fundingFields, mode: z.literal("post"),
    expectedBookBalance: z.string().regex(/^-?\d{1,22}(?:\.\d{1,6})?$/),
  }).strict(),
]);
export type AdministrativeCustodyFundingInput = z.output<typeof administrativeCustodyFundingSchema>;
function conflict(code: string, message: string): never {
  throw new HttpError(409, code, message);
}
// As in sales till closing, reversed originals remain part of the ledger and
// are offset by their posted reversal. Drafts never enter the count.
export const custodyBookBalanceSql = `SELECT COALESCE(sum(l.base_debit-l.base_credit),0)::text AS amount
  FROM financial_document_lines l
  JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id
  WHERE l.company_id=$1 AND l.account_id=$2 AND d.status<>'draft'`;

export function custodyFundingVarianceLines(
  custodyId: number, varianceAccountId: number, book: bigint, counted: bigint, description: string,
) {
  const difference = counted - book;
  if (difference === 0n) return [];
  const magnitude = moneyString(difference > 0n ? difference : -difference);
  return [
    {accountId: custodyId, debit: difference > 0n ? magnitude : "0",
      credit: difference < 0n ? magnitude : "0", description},
    {accountId: varianceAccountId, debit: difference < 0n ? magnitude : "0",
      credit: difference > 0n ? magnitude : "0", description},
  ];
}

function fundingResult(row: Record<string, unknown>) {
  const variance = row.variance_amount == null ? 0n : moneyUnits(String(row.variance_amount));
  return {
    operationId: row.id as number,
    documentId: row.financial_document_id as number,
    varianceDocumentId: (row.variance_document_id ?? null) as number | null,
    varianceKind: variance > 0n ? "surplus" as const : variance < 0n ? "shortage" as const : null,
    varianceAmount: moneyString(variance < 0n ? -variance : variance),
  };
}

export async function postAdministrativeCustodyFunding(
  client: PoolClient, companyId: number, user: User, input: AdministrativeCustodyFundingInput,
) {
  // Serialized by the company row lock; idempotent retries never double-post.
  const previous = await client.query(
    "SELECT id,financial_document_id,variance_amount,variance_document_id,created_by,request_payload=$3::jsonb AS same_payload FROM administrative_custody_fundings WHERE company_id=$1 AND idempotency_key=$2",
    [companyId, input.idempotencyKey, JSON.stringify(input)],
  );
  if (input.mode === "post" && previous.rows[0]) {
    if (previous.rows[0].created_by !== user.id || !previous.rows[0].same_payload)
      conflict("custody_funding_key_conflict", "مفتاح التغذية مستخدم لعملية أخرى");
    return fundingResult(previous.rows[0]);
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
    `SELECT c.id,c.code,c.active,c.decimal_places FROM finance_settings f
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
  const counted = moneyUnits(input.countedCash);
  const book = moneyUnits((await client.query(custodyBookBalanceSql, [companyId, custody.id])).rows[0].amount);
  const difference = counted - book;
  if ([book, counted, difference, counted + amount].some(value =>
    value > 10n ** 28n - 1n || value < -(10n ** 28n - 1n)))
    conflict("custody_funding_count_overflow", "رصيد العهدة أو فرق المطابقة يتجاوز الحد المدعوم");
  checkQuantum(moneyString(amount), currency.decimal_places);
  checkQuantum(moneyString(counted), currency.decimal_places);
  checkQuantum(moneyString(difference < 0n ? -difference : difference), currency.decimal_places);
  let varianceAccountId: number | null = null;
  if (difference !== 0n) {
    const varianceAccount = (await client.query(
      `SELECT a.id,a.active,a.kind,a.category FROM account_links l
       JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
       WHERE l.company_id=$1 AND l.purpose='cashVariance'`, [companyId],
    )).rows[0];
    if (!varianceAccount?.active || varianceAccount.kind !== "posting" ||
        varianceAccount.category !== "expense" || [cash.id,custody.id].includes(varianceAccount.id))
      conflict("custody_funding_variance_account_missing",
        "اربط حساب عجز وزيادة الصناديق الحركي والفعال قبل ترحيل الفرق");
    varianceAccountId = varianceAccount.id;
  }
  if (input.mode === "preview") return {
    bookBalance: moneyString(book),
    varianceKind: difference > 0n ? "surplus" as const : difference < 0n ? "shortage" as const : null,
    varianceAmount: moneyString(difference < 0n ? -difference : difference),
  };
  if (moneyUnits(input.expectedBookBalance) !== book)
    conflict("custody_funding_count_changed", "تغيّر رصيد العهدة قبل الترحيل. أعد عد النقد والمطابقة ثم أكّد.");
  let varianceDocumentId: number | null = null;
  if (varianceAccountId !== null) {
    const varianceMemo = (`${difference < 0n ? "عجز" : "زيادة"} صندوق العهدة قبل التغذية — ${employee.name}`).slice(0, 500);
    varianceDocumentId = await postCommerceJournal(client, companyId, user, {
      documentDate: businessDate, branchId: null, currencyId: currency.id as number,
      description: varianceMemo, idempotencyKey: randomUUID(),
      lines: custodyFundingVarianceLines(custody.id, varianceAccountId, book, counted, varianceMemo),
    });
  }
  const documentId = await postCommerceJournal(client, companyId, user, {
    documentDate: businessDate, branchId: null, currencyId: currency.id as number,
    description: memo, idempotencyKey: randomUUID(),
    lines: [
      {accountId: cash.id as number, debit: "0", credit: moneyString(amount), description: memo.slice(0, 500)},
      {accountId: custody.id as number, debit: moneyString(amount), credit: "0", description: memo.slice(0, 500)},
    ],
  });
  const row = await client.query(
    `INSERT INTO administrative_custody_fundings
     (company_id,employee_id,employee_name,cash_account_id,custody_account_id,
      amount,notes,financial_document_id,idempotency_key,request_payload,created_by,
      counted_cash,book_balance_before,variance_amount,variance_document_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id,financial_document_id,variance_amount,variance_document_id`,
    [companyId, employee.id, employee.name, cash.id, custody.id, moneyString(amount),
      input.notes, documentId, input.idempotencyKey, JSON.stringify(input), user.id,
      moneyString(counted),moneyString(book),moneyString(difference),varianceDocumentId],
  );
  const operationId = row.rows[0].id as number;
  await audit(client, user, "administrativeCustody.fund", "administrative-custody-funding",
    operationId, null, {employeeId:employee.id,cashAccountId:cash.id,
      custodyAccountId:custody.id,amount:moneyString(amount),documentId,notes:input.notes,
      countedCash:moneyString(counted),bookBalanceBefore:moneyString(book),
      varianceAmount:moneyString(difference),varianceDocumentId},companyId);
  return fundingResult(row.rows[0]);
}
