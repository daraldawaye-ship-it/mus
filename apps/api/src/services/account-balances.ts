import type { PoolClient, QueryResultRow } from "pg";
import type { Request } from "express";
import type { z } from "zod";
import {
  accountBalanceApprovalSchema,
  type AccountBalanceApproval,
  type AccountBalanceFollowUp,
  type AccountBalanceStatistics,
  type AccountStatisticsComponentMetadata,
  type User,
} from "../../../../packages/contracts/src/index.ts";
import { HttpError, missing } from "../errors.ts";
import {
  assertAccountBalanceAccess,
  assertRequestPagesEnabled,
} from "./pages.ts";
import { audit } from "./audit.ts";
import { conflict } from "./masters.ts";

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;
// PostgreSQL numeric text stays exact, including values above Number's range.
const decimal = (value: string): string => {
  const result = value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
  return result === "-0" ? "0" : result;
};
export function followUpDTO(row: QueryResultRow): AccountBalanceFollowUp {
  return {
    id: row.id,
    companyId: row.company_id,
    accountId: row.account_id,
    followedUpAt: iso(row.followed_up_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    note: row.note,
  };
}
export function approvalDTO(row: QueryResultRow): AccountBalanceApproval {
  return {
    id: row.id,
    companyId: row.company_id,
    accountId: row.account_id,
    balanceDate: row.balance_date_text,
    balanceBase: decimal(row.balance_base),
    currency: {
      id: row.base_currency_id,
      code: row.base_currency_code,
      decimalPlaces: row.base_decimal_places,
    },
    sourceRevision: row.source_revision,
    sourceGeneration: row.source_generation,
    policyVersion: row.policy_version,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    note: row.note,
  };
}
export async function postingAccount(
  client: PoolClient,
  companyId: number,
  accountId: number,
): Promise<void> {
  const result = await client.query(
    "SELECT kind FROM accounts WHERE company_id=$1 AND id=$2 FOR SHARE",
    [companyId, accountId],
  );
  if (!result.rows[0]) missing();
  if (result.rows[0].kind !== "posting")
    conflict("إحصاءات الرصيد متاحة للحسابات الحركية فقط");
}
export async function balanceDate(
  client: PoolClient,
  requested?: string,
): Promise<string> {
  const today = (
    await client.query(
      "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today",
    )
  ).rows[0].today as string;
  if (requested && requested > today)
    throw new HttpError(
      400,
      "invalid_date",
      "تاريخ الرصيد لا يتجاوز اليوم الحالي",
    );
  return requested ?? today;
}
export async function refreshBalance(
  client: PoolClient,
  companyId: number,
  accountId: number,
  asOfDate: string,
): Promise<QueryResultRow> {
  const refreshed = await client.query(
    "SELECT refresh_account_balance_statistics($1,$2,$3::date) AS ready",
    [companyId, accountId, asOfDate],
  );
  if (!refreshed.rows[0].ready)
    conflict("يلزم تحديد عملة أساسية فعالة قبل احتساب الرصيد");
  return (
    await client.query(
      `SELECT *,balance_as_of_date::text AS balance_date_text,
        activity_as_of_date::text AS activity_date_text,
        commerce_as_of_date::text AS commerce_date_text,
        stock_as_of_date::text AS stock_date_text
       FROM account_statistics WHERE company_id=$1 AND account_id=$2`,
      [companyId, accountId],
    )
  ).rows[0]!;
}
function quote(row: QueryResultRow) {
  return {
    balanceDate: row.balance_date_text as string,
    expectedBalanceBase: decimal(row.balance_current_base),
    expectedCurrencyId: row.balance_currency_id as number,
    expectedSourceRevision: row.source_revision as string,
    expectedSourceGeneration: row.balance_generation as string,
  };
}
export async function readBalanceStatistics(
  client: PoolClient,
  user: User,
  companyId: number,
  accountId: number,
  asOfDate: string,
): Promise<AccountBalanceStatistics> {
  const row = await refreshBalance(client, companyId, accountId, asOfDate);
  const follow = await client.query(
    "SELECT * FROM account_balance_followups WHERE company_id=$1 AND account_id=$2 ORDER BY followed_up_at DESC,id DESC LIMIT 1",
    [companyId, accountId],
  );
  const approval = await client.query(
    "SELECT *,balance_date::text AS balance_date_text FROM account_balance_approvals WHERE company_id=$1 AND account_id=$2 AND source_generation=$3::uuid ORDER BY created_at DESC,id DESC LIMIT 1",
    [companyId, accountId, row.balance_generation],
  );
  const metadata = (component: string): AccountStatisticsComponentMetadata =>
    row[`${component}_state`] === "uncomputed"
      ? {
          state: "uncomputed",
          computedRevision: null,
          asOfDate: null,
          computedAt: null,
        }
      : {
          state: row[`${component}_state`],
          computedRevision: row[`${component}_computed_revision`],
          asOfDate: row[`${component}_date_text`],
          computedAt: iso(row[`${component}_computed_at`]),
        };
  const allowed = async (action: "followup" | "approve") => {
    try {
      await assertAccountBalanceAccess(client, user, companyId, action);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) return false;
      throw error;
    }
  };
  return {
    companyId,
    accountId,
    asOfDate,
    policyVersion: row.policy_version,
    sourceRevision: row.source_revision,
    sourceGeneration: row.balance_generation,
    coverage: "recorded_history_only",
    currency: {
      id: row.balance_currency_id,
      code: row.balance_currency_code,
      decimalPlaces: row.balance_currency_decimal_places,
    },
    balance: {
      currentBase: decimal(row.balance_current_base),
      oneYearAgoBase: decimal(row.balance_one_year_ago_base),
      atCurrentYearStartBase: decimal(row.balance_at_current_year_start_base),
      atPreviousYearStartBase: decimal(row.balance_at_previous_year_start_base),
      atTwoYearsAgoStartBase: decimal(row.balance_at_two_years_ago_start_base),
    },
    components: {
      balance: metadata("balance"),
      activity: metadata("activity"),
      commerce: metadata("commerce"),
      stock: metadata("stock"),
    },
    lastFollowUp: follow.rows[0] ? followUpDTO(follow.rows[0]) : null,
    lastApproval: approval.rows[0] ? approvalDTO(approval.rows[0]) : null,
    approvalQuote: quote(row),
    capabilities: {
      canFollowUp: await allowed("followup"),
      canApprove: await allowed("approve"),
    },
  };
}
/** Company/user locks and current permission checks precede this function. */
export async function acceptedBalanceAction(
  client: PoolClient,
  table: "account_balance_followups" | "account_balance_approvals",
  companyId: number,
  accountId: number,
  user: User,
  key: string,
  payload: object,
): Promise<QueryResultRow | null> {
  const result = await client.query(
    `SELECT *,${table === "account_balance_approvals" ? "balance_date::text" : "NULL::text"} AS balance_date_text,request_payload=$3::jsonb AS same_payload FROM ${table} WHERE company_id=$1 AND idempotency_key=$2::uuid`,
    [companyId, key, JSON.stringify(payload)],
  );
  const prior = result.rows[0];
  if (
    prior &&
    (prior.account_id !== accountId ||
      prior.created_by !== user.id ||
      !prior.same_payload)
  )
    conflict("هوية الطلب مستخدمة لعملية أخرى أو بيانات مختلفة");
  return prior ?? null;
}
export async function recordFollowUp(
  client: PoolClient,
  req: Request,
  user: User,
  companyId: number,
  accountId: number,
  input: { idempotencyKey: string; note: string },
): Promise<AccountBalanceFollowUp> {
  const payload = { note: input.note };
  const prior = await acceptedBalanceAction(
    client,
    "account_balance_followups",
    companyId,
    accountId,
    user,
    input.idempotencyKey,
    payload,
  );
  if (prior) return followUpDTO(prior);
  await assertRequestPagesEnabled(client, req, true);
  const row = (
    await client.query(
      "INSERT INTO account_balance_followups(company_id,account_id,followed_up_at,created_by,note,idempotency_key,request_payload) VALUES($1,$2,clock_timestamp(),$3,$4,$5,$6::jsonb) RETURNING *",
      [
        companyId,
        accountId,
        user.id,
        input.note,
        input.idempotencyKey,
        JSON.stringify(payload),
      ],
    )
  ).rows[0]!;
  const event = followUpDTO(row);
  await audit(
    client,
    user,
    "accountBalance.followup",
    "accountBalanceFollowup",
    event.id,
    null,
    event,
    companyId,
  );
  return event;
}
export async function recordApproval(
  client: PoolClient,
  req: Request,
  user: User,
  companyId: number,
  accountId: number,
  input: z.output<typeof accountBalanceApprovalSchema>,
): Promise<AccountBalanceApproval> {
  const { idempotencyKey, ...payload } = input;
  const prior = await acceptedBalanceAction(
    client,
    "account_balance_approvals",
    companyId,
    accountId,
    user,
    idempotencyKey,
    payload,
  );
  if (prior) return approvalDTO(prior);
  await assertRequestPagesEnabled(client, req, true);
  const asOfDate = await balanceDate(client, input.balanceDate);
  const row = await refreshBalance(client, companyId, accountId, asOfDate);
  const actual = quote(row);
  if (
    actual.expectedBalanceBase !== input.expectedBalanceBase ||
    actual.expectedCurrencyId !== input.expectedCurrencyId ||
    actual.expectedSourceRevision !== input.expectedSourceRevision ||
    actual.expectedSourceGeneration !==
      input.expectedSourceGeneration.toLowerCase()
  )
    conflict("تغير مصدر الرصيد منذ عرضه؛ أعد عرض الرصيد قبل اعتماده");
  const saved = (
    await client.query(
      "INSERT INTO account_balance_approvals(company_id,account_id,balance_date,balance_base,base_currency_id,base_currency_code,base_decimal_places,source_revision,source_generation,policy_version,created_by,note,idempotency_key,request_payload) VALUES($1,$2,$3::date,$4::numeric,$5,$6,$7,$8::bigint,$9::uuid,$10,$11,$12,$13::uuid,$14::jsonb) RETURNING *,balance_date::text AS balance_date_text",
      [
        companyId,
        accountId,
        asOfDate,
        actual.expectedBalanceBase,
        row.balance_currency_id,
        row.balance_currency_code,
        row.balance_currency_decimal_places,
        row.source_revision,
        row.balance_generation,
        row.policy_version,
        user.id,
        input.note,
        idempotencyKey,
        JSON.stringify(payload),
      ],
    )
  ).rows[0]!;
  const event = approvalDTO(saved);
  await audit(
    client,
    user,
    "accountBalance.approve",
    "accountBalanceApproval",
    event.id,
    null,
    event,
    companyId,
  );
  return event;
}
