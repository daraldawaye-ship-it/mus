import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { moneyString, moneyUnits } from "./finance.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";
import { audit } from "./audit.ts";
import { checkPendingReceipts } from "./cashbox-notifications.ts";

export { administrativeCustodyTransferSchema } from "../../../../packages/contracts/src/administrative-custody.ts";
import type { AdministrativeCustodyTransferInput } from "../../../../packages/contracts/src/administrative-custody.ts";
import { custodyMedicalBeneficiary, markCustodyMedicalSales } from "./custody-medical-expense.ts";

function conflict(code: string, message: string): never {
  throw new HttpError(409, code, message);
}

export async function postAdministrativeCustodyTransfer(
  client: PoolClient,
  companyId: number,
  user: User,
  input: AdministrativeCustodyTransferInput,
) {
  // Serialize identical requests before checking the immutable operation receipt.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["custody:" + companyId + ":" + input.idempotencyKey]);
  // Replays return the original journal only for the original user and payload.
  const previous = await client.query(
    "SELECT id,financial_document_id,created_by,request_payload=$3::jsonb AS same_payload FROM administrative_custody_transfers WHERE company_id=$1 AND idempotency_key=$2",
    [companyId, input.idempotencyKey, JSON.stringify(input)],
  );
  if (previous.rows[0]) {
    const row = previous.rows[0];
    if (row.created_by !== user.id || !row.same_payload)
      conflict("custody_key_conflict", "مفتاح الترحيل مستخدم لعملية أخرى");
    return { operationId: row.id as number, documentId: row.financial_document_id as number };
  }

  const amount = moneyUnits(input.amount);
  if (amount === 0n)
    conflict("custody_amount_zero", "أدخل مبلغًا موجبًا أو سالبًا غير صفري");
  if (amount > 10n ** 28n - 1n || amount < -(10n ** 28n - 1n))
    conflict("custody_amount_excess", "المبلغ يتجاوز الحد المدعوم");

  const expenseKind = input.expenseKind ?? "other";
  const beneficiary = await custodyMedicalBeneficiary(client, companyId, input);

  // Resolve both accounts server-side and only from the company's system links.
  // Never accept arbitrary account IDs from the invoice browser.
  const linked = await client.query(
    "SELECT l.purpose,a.id,a.name,a.active,a.kind,a.category FROM account_links l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.purpose IN ('administrativeCustody','administrativeCustodyPouch')",
    [companyId],
  );
  const custody = linked.rows.find((row) => row.purpose === "administrativeCustody");
  const pouch = linked.rows.find((row) => row.purpose === "administrativeCustodyPouch");
  if (!custody || !custody.active || custody.kind !== "posting" || custody.category !== "asset")
    conflict("custody_not_configured", "اربط حساب العهدة الإدارية الحركي من ربط الحسابات النظامية أولًا");
  if (!pouch || !pouch.active || pouch.kind !== "posting" || pouch.category !== "asset")
    conflict("custody_wallet_not_configured", "اربط حساب حافظة العهدة الإدارية الحركي من ربط الحسابات النظامية أولًا");
  if (custody.id === pouch.id)
    conflict("custody_same_account", "يجب أن يختلف حساب العهدة عن حافظتها");

  const base = await client.query(
    "SELECT c.id,c.code,c.active FROM finance_settings f JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id WHERE f.company_id=$1",
    [companyId],
  );
  const currency = base.rows[0];
  if (!currency?.active || currency.code !== "YER")
    conflict("custody_currency", "تتطلب عملية العهدة أن يكون الريال اليمني العملة الأساسية");

  const transfer = amount > 0n ? amount : -amount;
  const direction = amount > 0n
    ? "ترحيل من العهدة الإدارية إلى حافظتها"
    : "استلام من حافظة العهدة الإدارية إلى العهدة";
  const purpose = beneficiary ? (expenseKind === "slips"
    ? `صرف للقصاصة — الممرض ${beneficiary.name} — عدد القصاصات: ${input.slipCount}`
    : `صرف لـ${beneficiary.kind === "doctor" ? "الطبيب" : "الممرض"} ${beneficiary.name}`) : direction;
  const memo = (purpose + (input.notes ? " — " + input.notes : "")).slice(0, 1000);
  const marking = await markCustodyMedicalSales(client, companyId, user.id, beneficiary, expenseKind);
  const lines = amount > 0n
    ? [
        { accountId: custody.id as number, debit: "0", credit: moneyString(transfer), description: memo },
        { accountId: pouch.id as number, debit: moneyString(transfer), credit: "0", description: memo },
      ]
    : [
        { accountId: custody.id as number, debit: moneyString(transfer), credit: "0", description: memo },
        { accountId: pouch.id as number, debit: "0", credit: moneyString(transfer), description: memo },
      ];

  // Deliberately no balance/availability rejection. Signed ledger balances
  // are valid on BOTH sides of the balanced journal.
  const currentDate = await client.query(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS date",
  );
  const documentId = await postCommerceJournal(client, companyId, user, {
    documentDate: currentDate.rows[0].date as string,
    branchId: null,
    currencyId: currency.id as number,
    description: memo,
    idempotencyKey: randomUUID(),
    lines,
  });
  const inserted = await client.query(
    "INSERT INTO administrative_custody_transfers(company_id,custody_account_id,pouch_account_id,amount,notes,financial_document_id,idempotency_key,request_payload,created_by,expense_kind,doctor_id,doctor_name,doctor_main_name,doctor_kind,slip_count,accounted_cutoff_invoice_id,accounted_invoice_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id",
    [companyId, custody.id, pouch.id, moneyString(amount), input.notes, documentId,
      input.idempotencyKey, JSON.stringify(input), user.id, expenseKind, beneficiary?.id ?? null,
      beneficiary?.name ?? null, beneficiary?.mainName ?? null, beneficiary?.kind ?? null,
      input.slipCount ?? null, marking.cutoffInvoiceId, marking.newlyMarked],
  );
  const operationId = inserted.rows[0].id as number;
  await audit(client, user, "administrativeCustody.transfer", "administrative-custody-transfer",
    operationId, null, { amount: moneyString(amount), custodyAccountId: custody.id,
      pouchAccountId: pouch.id, documentId, notes: input.notes, expenseKind,
      doctorId: beneficiary?.id ?? null, doctorName: beneficiary?.name ?? null,
      doctorMainName: beneficiary?.mainName ?? null, doctorKind: beneficiary?.kind ?? null,
      slipCount: input.slipCount ?? null, ...marking }, companyId);
  if (marking.cutoffInvoiceId !== null) await audit(client, user, "doctor.sales.accounted", "invoice",
    marking.cutoffInvoiceId, null, { mainName: beneficiary!.mainName, kind: beneficiary!.kind,
      ...marking, source: "custody_medical_payment", operationId, documentId }, companyId);
  await checkPendingReceipts(client, companyId, "pouch", "custody:" + operationId);
  return { operationId, documentId };
}
