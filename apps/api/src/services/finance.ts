import type { PoolClient, QueryResultRow } from "pg";
import type { Database } from "../db.ts";
import { HttpError, missing } from "../errors.ts";
import { conflict } from "./masters.ts";
import {
  normalizeRate,
  type FinancialDocument,
  type FinancialLine,
  type financialDocumentSchema,
} from "../../../../packages/contracts/src/index.ts";
import type { z } from "zod";

export type DocumentFields = Omit<
  z.output<typeof financialDocumentSchema>,
  "idempotencyKey"
>;
export const MONEY_SCALE = 6;
const MAX_LINE_UNITS = 10n ** 28n - 1n;
export function moneyUnits(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,6}$/.test(fraction))
    throw new Error("Invalid exact money");
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return negative ? -result : result;
}
export function moneyString(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 1_000_000n;
  const fraction = (magnitude % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
export function quantum(places: number): bigint {
  return 10n ** BigInt(6 - places);
}
export function checkQuantum(value: string, places: number): void {
  if (moneyUnits(value) % quantum(places) !== 0n)
    throw new HttpError(
      400,
      "currency_precision",
      `المبلغ يتجاوز دقة العملة (${places} خانات كسرية)`,
    );
}
export function convertedUnits(
  value: string,
  rate: string,
  basePlaces: number,
): bigint {
  const [whole, fraction = ""] = rate.split(".");
  const rateUnits =
    BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, "0"));
  const step = quantum(basePlaces);
  const numerator = moneyUnits(value) * rateUnits;
  const denominator = 10n ** 12n * step;
  const result =
    (numerator / denominator +
      ((numerator % denominator) * 2n >= denominator ? 1n : 0n)) *
    step;
  if (result > MAX_LINE_UNITS)
    throw new HttpError(
      400,
      "amount_overflow",
      "المبلغ بعد تحويل العملة يتجاوز الحد المدعوم",
    );
  return result;
}
const iso = (value: Date | string): string => new Date(value).toISOString();
export const financialFrom =
  "FROM financial_documents d JOIN company_currencies c ON c.company_id=d.company_id AND c.id=d.currency_id JOIN users u ON u.id=d.created_by LEFT JOIN branches b ON b.company_id=d.company_id AND b.id=d.branch_id";
export const financialSelect = `SELECT d.*,d.document_date::text AS date_text,COALESCE(d.currency_code,c.code) AS actual_currency_code,COALESCE(d.currency_name,c.name) AS actual_currency_name,COALESCE(d.decimal_places,c.decimal_places) AS actual_decimal_places,COALESCE(d.branch_name,b.name) AS actual_branch_name,u.display_name AS created_by_name ${financialFrom}`;
export function financialLineDTO(row: QueryResultRow): FinancialLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    accountId: row.account_id,
    accountCode: row.actual_account_code,
    accountName: row.actual_account_name,
    debit: normalizeRate(row.debit),
    credit: normalizeRate(row.credit),
    baseDebit: row.base_debit === null ? null : normalizeRate(row.base_debit),
    baseCredit:
      row.base_credit === null ? null : normalizeRate(row.base_credit),
    description: row.description,
  };
}
export async function documentDTOs(
  db: Database,
  rows: QueryResultRow[],
): Promise<FinancialDocument[]> {
  if (!rows.length) return [];
  const lines = await db.query(
    "SELECT l.*,COALESCE(l.account_code,a.code) AS actual_account_code,COALESCE(l.account_name,a.name) AS actual_account_name FROM financial_document_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.document_id=ANY($2::integer[]) ORDER BY l.document_id,l.line_number",
    [rows[0].company_id, rows.map((row) => row.id)],
  );
  const byDocument = new Map<number, FinancialLine[]>();
  for (const line of lines.rows) {
    const group = byDocument.get(line.document_id) ?? [];
    group.push(financialLineDTO(line));
    byDocument.set(line.document_id, group);
  }
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    number: row.number,
    kind: row.kind,
    status: row.status,
    revision: row.revision,
    documentDate: row.date_text,
    currencyId: row.currency_id,
    currencyCode: row.actual_currency_code,
    currencyName: row.actual_currency_name,
    decimalPlaces: row.actual_decimal_places,
    baseCurrencyId: row.base_currency_id,
    baseCurrencyCode: row.base_currency_code,
    baseDecimalPlaces: row.base_decimal_places,
    exchangeRate:
      row.exchange_rate === null ? null : normalizeRate(row.exchange_rate),
    exchangeRateId: row.exchange_rate_id,
    exchangeRateSource: row.exchange_rate_source,
    branchId: row.branch_id,
    branchName: row.actual_branch_name,
    cashAccountId: row.cash_account_id,
    description: row.description,
    lines: byDocument.get(row.id) ?? [],
    totalDebit: normalizeRate(row.total_debit),
    totalCredit: normalizeRate(row.total_credit),
    totalBaseDebit:
      row.total_base_debit === null
        ? null
        : normalizeRate(row.total_base_debit),
    totalBaseCredit:
      row.total_base_credit === null
        ? null
        : normalizeRate(row.total_base_credit),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: iso(row.created_at),
    postedBy: row.posted_by,
    postedAt: row.posted_at === null ? null : iso(row.posted_at),
    reversalDocumentId: row.reversal_document_id,
    reversesDocumentId: row.reverses_document_id,
  }));
}
export async function documentRow(
  db: Database,
  companyId: number,
  documentId: number,
  lock = false,
): Promise<QueryResultRow> {
  const result = await db.query(
    `${financialSelect} WHERE d.company_id=$1 AND d.id=$2 ${lock ? "FOR UPDATE OF d" : ""}`,
    [companyId, documentId],
  );
  if (!result.rows[0]) missing();
  return result.rows[0];
}
export async function loadDocument(
  db: Database,
  companyId: number,
  documentId: number,
): Promise<FinancialDocument> {
  return (
    await documentDTOs(db, [await documentRow(db, companyId, documentId)])
  )[0];
}
export async function nextDocumentNumber(
  client: PoolClient,
  companyId: number,
): Promise<string> {
  const result = await client.query(
    "INSERT INTO financial_document_counters(company_id,next_number) VALUES($1,2) ON CONFLICT(company_id) DO UPDATE SET next_number=financial_document_counters.next_number+1 RETURNING (next_number-1)::text AS number",
    [companyId],
  );
  return result.rows[0].number.padStart(10, "0");
}
export async function checkDocumentReferences(
  db: Database,
  companyId: number,
  input: DocumentFields,
): Promise<void> {
  const currency = await db.query(
    "SELECT * FROM company_currencies WHERE company_id=$1 AND id=$2",
    [companyId, input.currencyId],
  );
  if (!currency.rows[0]?.active) conflict("اختر عملة فعالة من الشركة");
  for (const line of input.lines) {
    checkQuantum(line.debit, currency.rows[0].decimal_places);
    checkQuantum(line.credit, currency.rows[0].decimal_places);
  }
  if (input.branchId !== null) {
    const branch = await db.query(
      "SELECT 1 FROM branches WHERE company_id=$1 AND id=$2 AND active",
      [companyId, input.branchId],
    );
    if (!branch.rowCount) conflict("اختر فرعًا فعالًا من الشركة");
  }
  const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
  const accounts = await db.query(
    "SELECT * FROM accounts WHERE company_id=$1 AND id=ANY($2::integer[]) AND active AND kind='posting'",
    [companyId, accountIds],
  );
  if (accounts.rows.length !== accountIds.length)
    conflict("كل سطر يحتاج حسابًا حركيًا فعالًا من الشركة");
  if (input.kind === "journal") {
    if (input.cashAccountId !== null)
      throw new HttpError(
        400,
        "invalid_voucher",
        "قيد اليومية لا يملك حقل حساب الصندوق",
      );
  } else {
    const cash = accounts.rows.find(
      (account) => account.id === input.cashAccountId,
    );
    if (!cash?.cash_or_bank || cash.category !== "asset")
      conflict("اختر حسابًا معرفًا كصندوق أو بنك من الشركة");
    if (input.lines.length !== 2 || accountIds.length !== 2)
      throw new HttpError(
        400,
        "invalid_voucher",
        "السند يتطلب حساب الصندوق وحسابًا مقابلًا مختلفًا",
      );
    const cashLine = input.lines.find(
      (line) => line.accountId === input.cashAccountId,
    )!;
    const other = input.lines.find(
      (line) => line.accountId !== input.cashAccountId,
    )!;
    if (
      (input.kind === "receipt" &&
        (moneyUnits(cashLine.credit) !== 0n ||
          moneyUnits(other.debit) !== 0n)) ||
      (input.kind === "payment" &&
        (moneyUnits(cashLine.debit) !== 0n || moneyUnits(other.credit) !== 0n))
    )
      throw new HttpError(
        400,
        "invalid_voucher",
        "اتجاه طرف الصندوق لا يطابق نوع السند",
      );
  }
}
export async function replaceDraftLines(
  client: PoolClient,
  companyId: number,
  documentId: number,
  lines: DocumentFields["lines"],
): Promise<void> {
  await client.query(
    "DELETE FROM financial_document_lines WHERE company_id=$1 AND document_id=$2",
    [companyId, documentId],
  );
  for (const [index, line] of lines.entries())
    await client.query(
      "INSERT INTO financial_document_lines(company_id,document_id,line_number,account_id,debit,credit,description) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        companyId,
        documentId,
        index + 1,
        line.accountId,
        line.debit,
        line.credit,
        line.description,
      ],
    );
}
export function documentTotals(lines: DocumentFields["lines"]): {
  debit: string;
  credit: string;
} {
  return {
    debit: moneyString(
      lines.reduce((sum, line) => sum + moneyUnits(line.debit), 0n),
    ),
    credit: moneyString(
      lines.reduce((sum, line) => sum + moneyUnits(line.credit), 0n),
    ),
  };
}
export function assertBalanced(lines: DocumentFields["lines"]): void {
  if (
    lines.some(
      (line) =>
        (moneyUnits(line.debit) === 0n) === (moneyUnits(line.credit) === 0n),
    )
  )
    throw new HttpError(
      400,
      "invalid_entry",
      "كل سطر مرحل يجب أن يحمل مبلغًا موجبًا في المدين أو الدائن فقط",
    );
  const total = documentTotals(lines);
  if (total.debit !== total.credit)
    throw new HttpError(
      400,
      "unbalanced_entry",
      "إجمالي المدين لا يساوي إجمالي الدائن",
    );
}
export async function findIdempotent(
  db: Database,
  companyId: number,
  key: string,
  payload: unknown,
): Promise<QueryResultRow | null> {
  const result = await db.query(
    "SELECT *,creation_payload=$3::jsonb AS same_payload FROM financial_documents WHERE company_id=$1 AND idempotency_key=$2",
    [companyId, key, JSON.stringify(payload)],
  );
  if (!result.rows[0]) return null;
  if (!result.rows[0].same_payload)
    conflict(
      "مفتاح العملية مستخدم لبيانات مختلفة؛ لا تعد إرسال بيانات معدلة بنفس المفتاح",
    );
  return result.rows[0];
}
