import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { z } from "zod";
import {
  normalizeRate,
  type User,
} from "../../../../packages/contracts/src/index.ts";
import type {
  WalletConversion,
  walletConversionSchema,
  walletConversionDecisionSchema,
} from "../../../../packages/contracts/src/wallet.ts";
import { HttpError, missing } from "../errors.ts";
import { audit } from "./audit.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";
import { walletSummary } from "./wallet.ts";
import {
  employeeWalletAccount,
  walletConversionPreview,
  walletPolicy,
  walletBaseCurrency,
} from "./wallet-policy.ts";

export const walletConversionQuery = `SELECT x.*,x.points::text,x.point_value::text,x.amount::text,d.number AS financial_document_number
 FROM wallet_conversions x LEFT JOIN financial_documents d ON d.company_id=x.company_id AND d.id=x.financial_document_id`;
export const walletConversionDTO = (row: QueryResultRow): WalletConversion => ({
  id: row.id,
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  status: row.status,
  points: row.points,
  pointValue: normalizeRate(row.point_value),
  amount: normalizeRate(row.amount),
  currencyId: row.currency_id,
  currencyCode: row.currency_code,
  decimalPlaces: row.decimal_places,
  expenseAccountId: row.expense_account_id,
  expenseAccountCode: row.expense_account_code,
  expenseAccountName: row.expense_account_name,
  accountId: row.account_id,
  accountCode: row.account_code,
  accountName: row.account_name,
  approvalMode: row.approval_mode,
  policyRevision: row.policy_revision,
  accountRevision: row.account_revision,
  revision: row.revision,
  financialDocumentId: row.financial_document_id,
  financialDocumentNumber: row.financial_document_number ?? null,
  entryId: row.entry_id,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  createdByName: row.created_by_name,
  decidedAt: row.decided_at?.toISOString() ?? null,
  decidedByName: row.decided_by_name ?? null,
  decisionReason: row.decision_reason ?? null,
});

async function loadConversion(
  client: PoolClient,
  companyId: number,
  conversionId: number,
): Promise<WalletConversion> {
  const found = await client.query(
    walletConversionQuery + " WHERE x.company_id=$1 AND x.id=$2",
    [companyId, conversionId],
  );
  if (!found.rows[0]) missing();
  return walletConversionDTO(found.rows[0]);
}
async function requestWithKey(
  client: PoolClient,
  companyId: number,
  user: User,
  key: string,
  payload: object,
  decision = false,
): Promise<WalletConversion | null> {
  const found = await client.query(
    "SELECT id,created_by,request_payload,idempotency_key,decided_by,decision_payload,decision_key FROM wallet_conversions WHERE company_id=$1 AND (idempotency_key=$2 OR decision_key=$2)",
    [companyId, key],
  );
  if (found.rows.length) {
    const row = found.rows[0];
    const matches = await client.query(
      `SELECT 1 FROM wallet_conversions WHERE company_id=$1 AND ${decision ? "decision_key=$2 AND decided_by=$3 AND decision_payload" : "idempotency_key=$2 AND created_by=$3 AND request_payload"}=$4::jsonb`,
      [companyId, key, user.id, JSON.stringify(payload)],
    );
    if (found.rows.length !== 1 || !matches.rowCount)
      throw new HttpError(
        409,
        "idempotency_conflict",
        "استُخدم مفتاح العملية ببيانات أو مستخدم آخر",
      );
    return loadConversion(client, companyId, row.id);
  }
  if (
    (
      await client.query(
        "SELECT 1 FROM employee_wallet_entries WHERE company_id=$1 AND idempotency_key=$2",
        [companyId, key],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      "idempotency_conflict",
      "استُخدم مفتاح العملية لحركة محفظة أخرى",
    );
  return null;
}

async function lockEmployeeWallet(
  client: PoolClient,
  companyId: number,
  employeeId: number,
  requireActive: boolean,
) {
  const found = await client.query(
    `SELECT e.id,e.name,e.active,NOT u.archived AS user_active FROM employees e JOIN users u ON u.id=e.user_id
     WHERE e.company_id=$1 AND e.id=$2 FOR UPDATE OF e`,
    [companyId, employeeId],
  );
  if (!found.rows[0]) missing();
  if (requireActive && (!found.rows[0].active || !found.rows[0].user_active))
    throw new HttpError(
      409,
      "invalid_employee",
      "لا يمكن ترحيل تحويل لموظف غير فعال",
    );
  await client.query(
    "SELECT 1 FROM employee_wallets WHERE company_id=$1 AND employee_id=$2 FOR UPDATE",
    [companyId, employeeId],
  );
}

async function currentReferences(
  client: PoolClient,
  companyId: number,
  employeeId: number,
) {
  await client.query(
    "SELECT 1 FROM wallet_conversion_policies WHERE company_id=$1 FOR SHARE",
    [companyId],
  );
  await client.query(
    "SELECT 1 FROM employee_wallet_accounts WHERE company_id=$1 AND employee_id=$2 FOR SHARE",
    [companyId, employeeId],
  );
  const policy = await walletPolicy(client, companyId),
    binding = await employeeWalletAccount(client, companyId, employeeId),
    base = await walletBaseCurrency(client, companyId);
  if (
    !binding.active ||
    !policy.pointValue ||
    !base?.active ||
    !policy.currency?.active ||
    base.id !== policy.currency.id ||
    base.code !== "YER" || policy.currency.code !== "YER" ||
    policy.pointValue !== "1" ||
    !policy.expenseAccount?.active ||
    policy.expenseAccount.kind !== "posting" ||
    policy.expenseAccount.category !== "expense" ||
    !binding.account?.active ||
    binding.account.kind !== "posting" ||
    binding.account.id === policy.expenseAccount.id ||
    !policy.approvalMode
  )
    throw new HttpError(
      409,
      "configuration_incomplete",
      "إعداد التحويل أو حساب الموظف غير جاهز؛ راجع إعدادات المحفظة",
    );
  await client.query(
    "SELECT 1 FROM accounts WHERE company_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR SHARE",
    [companyId, [policy.expenseAccount.id, binding.account.id]],
  );
  await client.query(
    "SELECT 1 FROM company_currencies WHERE company_id=$1 AND id=$2 FOR SHARE",
    [companyId, policy.currency.id],
  );
  return { policy, binding, base };
}
async function validateSnapshot(
  client: PoolClient,
  companyId: number,
  conversion: WalletConversion,
) {
  const { policy, binding, base } = await currentReferences(
    client,
    companyId,
    conversion.employeeId,
  );
  if (
    policy.revision !== conversion.policyRevision ||
    binding.revision !== conversion.accountRevision ||
    policy.pointValue !== conversion.pointValue ||
    policy.approvalMode !== conversion.approvalMode ||
    policy.currencyId !== conversion.currencyId ||
    base.decimalPlaces !== conversion.decimalPlaces ||
    base.code !== conversion.currencyCode ||
    policy.expenseAccountId !== conversion.expenseAccountId ||
    binding.accountId !== conversion.accountId
  )
    throw new HttpError(
      409,
      "configuration_changed",
      "تغيرت سياسة التحويل أو حساب الموظف؛ ارفض أو ألغِ الطلب ثم أنشئ طلبًا بالمعاينة الجديدة",
    );
}

async function postConversion(
  client: PoolClient,
  companyId: number,
  user: User,
  conversion: WalletConversion,
  decision?: { key: string; payload: object; reason: string },
) {
  const date = (
    await client.query(
      "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS date",
    )
  ).rows[0].date as string;
  const description = `تحويل ${conversion.points} نقطة للموظف ${conversion.employeeName} — طلب ${conversion.id}`;
  const journalId = await postCommerceJournal(client, companyId, user, {
    documentDate: date,
    branchId: null,
    currencyId: conversion.currencyId,
    description,
    idempotencyKey: randomUUID(),
    lines: [
      {
        accountId: conversion.expenseAccountId,
        debit: conversion.amount,
        credit: "0",
        description,
      },
      {
        accountId: conversion.accountId,
        debit: "0",
        credit: conversion.amount,
        description,
      },
    ],
  });
  const inserted = await client.query(
    `INSERT INTO employee_wallet_entries(company_id,employee_id,employee_name,kind,points,reason,conversion_id,financial_document_id,idempotency_key,request_payload,created_by,created_by_name)
     VALUES($1,$2,$3,'conversion',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      companyId,
      conversion.employeeId,
      conversion.employeeName,
      (-BigInt(conversion.points)).toString(),
      description,
      conversion.id,
      journalId,
      randomUUID(),
      JSON.stringify({ kind: "conversion", conversionId: conversion.id }),
      user.id,
      user.displayName,
    ],
  );
  await client.query(
    `UPDATE wallet_conversions SET status='posted',revision=revision+1,financial_document_id=$3,entry_id=$4,
     decided_at=clock_timestamp(),decided_by=$5,decided_by_name=$6,decision_key=$7,decision_payload=$8,decision_reason=$9
     WHERE company_id=$1 AND id=$2`,
    [
      companyId,
      conversion.id,
      journalId,
      inserted.rows[0].id,
      user.id,
      user.displayName,
      decision?.key ?? null,
      decision ? JSON.stringify(decision.payload) : null,
      decision?.reason ?? null,
    ],
  );
  return loadConversion(client, companyId, conversion.id);
}

export async function createWalletConversion(
  client: PoolClient,
  companyId: number,
  user: User,
  input: z.output<typeof walletConversionSchema>,
): Promise<WalletConversion> {
  const { idempotencyKey, ...fields } = input,
    payload = { action: "request", ...fields };
  const previous = await requestWithKey(
    client,
    companyId,
    user,
    idempotencyKey,
    payload,
  );
  if (previous) return previous;
  await lockEmployeeWallet(client, companyId, input.employeeId, true);
  if (
    (
      await client.query(
        "SELECT 1 FROM wallet_conversions WHERE company_id=$1 AND employee_id=$2 AND status='pending'",
        [companyId, input.employeeId],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      "pending_conversion",
      "لديك طلب تحويل ينتظر الاعتماد؛ أكمله أو ألغِه قبل طلب تحويل آخر",
    );
  const references = await currentReferences(
      client,
      companyId,
      input.employeeId,
    ),
    preview = await walletConversionPreview(
      client,
      companyId,
      input.employeeId,
    );
  if (
    preview.points !== input.expectedPoints ||
    preview.amount !== input.expectedAmount ||
    preview.policyRevision !== input.policyRevision ||
    preview.accountRevision !== input.accountRevision
  )
    throw new HttpError(
      409,
      "preview_changed",
      "تغير الرصيد أو إعداد التحويل؛ أعد المعاينة قبل التأكيد",
    );
  if (!preview.canConvert || !preview.amount)
    throw new HttpError(
      409,
      "conversion_unavailable",
      preview.unavailableReason || "الرصيد غير قابل للتحويل",
    );
  const before = await walletSummary(client, companyId, input.employeeId),
    { policy, binding } = references;
  const inserted = await client.query(
    `INSERT INTO wallet_conversions(company_id,employee_id,employee_name,points,point_value,amount,currency_id,currency_code,decimal_places,
     expense_account_id,expense_account_code,expense_account_name,account_id,account_code,account_name,approval_mode,policy_revision,account_revision,
     idempotency_key,request_payload,created_by,created_by_name)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
    [
      companyId,
      input.employeeId,
      binding.employeeName,
      preview.points,
      policy.pointValue,
      preview.amount,
      policy.currency!.id,
      policy.currency!.code,
      policy.currency!.decimalPlaces,
      policy.expenseAccount!.id,
      policy.expenseAccount!.code,
      policy.expenseAccount!.name,
      binding.account!.id,
      binding.account!.code,
      binding.account!.name,
      policy.approvalMode,
      policy.revision,
      binding.revision,
      idempotencyKey,
      JSON.stringify(payload),
      user.id,
      user.displayName,
    ],
  );
  let conversion = await loadConversion(client, companyId, inserted.rows[0].id);
  if (policy.approvalMode === "direct") {
    conversion = await postConversion(client, companyId, user, conversion);
    await audit(
      client,
      user,
      "wallet.conversion.post",
      "wallet-conversion",
      conversion.id,
      { wallet: before },
      {
        conversion,
        wallet: await walletSummary(client, companyId, input.employeeId),
      },
      companyId,
    );
  }
  await audit(
    client,
    user,
    "wallet.conversion.request",
    "wallet-conversion",
    conversion.id,
    { wallet: before },
    {
      conversion,
      wallet: await walletSummary(client, companyId, input.employeeId),
    },
    companyId,
  );
  return conversion;
}

export async function decideWalletConversion(
  client: PoolClient,
  companyId: number,
  user: User,
  conversionId: number,
  action: "approve" | "reject" | "cancel",
  input: z.output<typeof walletConversionDecisionSchema>,
): Promise<WalletConversion> {
  const payload = {
    action,
    conversionId,
    revision: input.revision,
    reason: input.reason,
  };
  const previous = await requestWithKey(
    client,
    companyId,
    user,
    input.idempotencyKey,
    payload,
    true,
  );
  if (previous) return previous;
  const found = await client.query(
    "SELECT 1 FROM wallet_conversions WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [companyId, conversionId],
  );
  if (!found.rowCount) missing();
  const before = await loadConversion(client, companyId, conversionId);
  // A manager may request their own points conversion, but must never authorize
  // the resulting expense and employee payable. Keep approval independent.
  if (action === "approve") {
    const ownRequest = await client.query(
      "SELECT 1 FROM employees WHERE company_id=$1 AND id=$2 AND user_id=$3",
      [companyId, before.employeeId, user.id],
    );
    if (ownRequest.rowCount)
      throw new HttpError(
        403,
        "self_approval_forbidden",
        "لا يجوز اعتماد تحويل نقاطك بنفسك؛ يجب أن يعتمده مدير آخر أو المالك",
      );
  }
  if (before.status !== "pending" || before.revision !== input.revision)
    throw new HttpError(
      409,
      "conversion_changed",
      "حُسم الطلب أو تغير إصداره؛ أعد تحميل سجل التحويلات",
    );
  await lockEmployeeWallet(
    client,
    companyId,
    before.employeeId,
    action === "approve",
  );
  const walletBefore = await walletSummary(
    client,
    companyId,
    before.employeeId,
  );
  let after: WalletConversion;
  if (action === "approve") {
    await validateSnapshot(client, companyId, before);
    after = await postConversion(client, companyId, user, before, {
      key: input.idempotencyKey,
      payload,
      reason: input.reason,
    });
  } else {
    await client.query(
      `UPDATE wallet_conversions SET status=$3,revision=revision+1,decided_at=clock_timestamp(),decided_by=$4,decided_by_name=$5,
       decision_reason=$6,decision_key=$7,decision_payload=$8 WHERE company_id=$1 AND id=$2`,
      [
        companyId,
        conversionId,
        action === "reject" ? "rejected" : "cancelled",
        user.id,
        user.displayName,
        input.reason,
        input.idempotencyKey,
        JSON.stringify(payload),
      ],
    );
    after = await loadConversion(client, companyId, conversionId);
  }
  await audit(
    client,
    user,
    `wallet.conversion.${action === "approve" ? "post" : action}`,
    "wallet-conversion",
    conversionId,
    { conversion: before, wallet: walletBefore },
    {
      conversion: after,
      wallet: await walletSummary(client, companyId, before.employeeId),
    },
    companyId,
  );
  return after;
}
