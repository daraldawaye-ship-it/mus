import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { moneyString, moneyUnits } from "./finance.ts";
import { postCommerceJournal } from "./commerce-ledger.ts";
import { audit } from "./audit.ts";
import { notifyCompanyCashiers } from "./cashbox-notifications.ts";

export const administrativeCustodyTransferSchema = z.object({
  amount: z.string().trim().regex(
    /^-?(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,2})?$/,
    "أدخل مبلغًا صالحًا بالريال اليمني حتى منزلتين عشريتين",
  ),
  notes: z.string().trim().max(1000),
  idempotencyKey: z.string().uuid(),
}).strict();

export type AdministrativeCustodyTransferInput = z.output<
  typeof administrativeCustodyTransferSchema
>;

function conflict(code: string, message: string): never {
  throw new HttpError(409, code, message);
}

export async function postAdministrativeCustodyTransfer(
  client: PoolClient,
  companyId: number,
  user: User,
  input: AdministrativeCustodyTransferInput,
) {
  // Called inside mutateMaster, which serializes the company's posting operations.
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
  const memo = (direction + (input.notes ? " — " + input.notes : "")).slice(0, 1000);
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
    "INSERT INTO administrative_custody_transfers(company_id,custody_account_id,pouch_account_id,amount,notes,financial_document_id,idempotency_key,request_payload,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [companyId, custody.id, pouch.id, moneyString(amount), input.notes, documentId,
      input.idempotencyKey, JSON.stringify(input), user.id],
  );
  const operationId = inserted.rows[0].id as number;
  await audit(client, user, "administrativeCustody.transfer", "administrative-custody-transfer",
    operationId, null, { amount: moneyString(amount), custodyAccountId: custody.id,
      pouchAccountId: pouch.id, documentId, notes: input.notes }, companyId);
  // Same receiver alert workflow as ordinary pouch transfers; never touch
  // employee cashboxes until a separate receipt is confirmed.
  await notifyCompanyCashiers(client, {
    companyId, operationId, employeeName: "العهدة الإدارية",
    kind: "custody", amount: moneyString(amount), variance: null,
  });
  return { operationId, documentId };
}
