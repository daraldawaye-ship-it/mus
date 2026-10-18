import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { insertDraft, postDraft } from "../routes-finance.ts";
import { audit } from "./audit.ts";
import {
  assertBalanced, loadDocument, moneyString,
  type DocumentFields,
} from "./finance.ts";

/**
 * Optional *additional* voucher, distinct from the immutable cashbox-to-pouch
 * receipt journal. No client cashbox, currency, date or amount is trusted.
 */
export const receiptExtraVoucherSchema = z.object({
  counterpartyAccountId: z.number().int().positive().max(2_147_483_647),
  notes: z.string().trim().max(1000),
  receiptNumber: z.string().trim().max(100).default(""),
}).strict();
export type ReceiptExtraVoucherInput = z.output<typeof receiptExtraVoucherSchema>;

export async function postReceiptExtraVoucher(
  client: PoolClient,
  companyId: number,
  user: User,
  settings: {
    sourceId: number;
    sourceKind: "pouch"|"electronic";
    actualAmount: bigint;
    cashAccountId: number;
    currencyId: number;
    documentDate: string;
    voucher: ReceiptExtraVoucherInput;
  },
): Promise<number> {
  const { sourceId,sourceKind,actualAmount,cashAccountId,currencyId,
    documentDate,voucher }=settings;
  if(actualAmount===0n) throw new HttpError(400,"empty_voucher",
    "لا يمكن إنشاء سند بقيمة صفر");
  if(voucher.counterpartyAccountId===cashAccountId)
    throw new HttpError(400,"same_cashbox","يجب أن يكون الحساب المقابل مختلفًا عن صندوقك");
  const other=(await client.query(
    "SELECT id FROM accounts WHERE company_id=$1 AND id=$2 AND active AND kind='posting'",
    [companyId,voucher.counterpartyAccountId],
  )).rows[0];
  if(!other) throw new HttpError(400,"invalid_counterparty",
    "الحساب المقابل غير موجود أو غير فعال في هذه الشركة");
  const kind=actualAmount>0n?"payment":"receipt";
  const amount=moneyString(actualAmount>0n?actualAmount:-actualAmount);
  const description=[
    voucher.notes||`سند مرافق لاستلام حركة #${sourceId}`,
    kind==="receipt"&&voucher.receiptNumber
      ? `رقم الوصل: ${voucher.receiptNumber}`:null,
  ].filter(Boolean).join(" — ").slice(0,1000);
  const fields:DocumentFields={
    kind,documentDate,currencyId,branchId:null,cashAccountId,
    supplierReceiptNumber:kind==="payment"?voucher.receiptNumber:"",
    description,
    lines:[
      {accountId:cashAccountId,
        debit:kind==="receipt"?amount:"0",
        credit:kind==="payment"?amount:"0",
        description:description.slice(0,500)},
      {accountId:voucher.counterpartyAccountId,
        debit:kind==="payment"?amount:"0",
        credit:kind==="receipt"?amount:"0",
        description:description.slice(0,500)},
    ],
  };
  assertBalanced(fields.lines);
  const payload={sourceKind,sourceId,kind,cashAccountId,currencyId,
    amount,counterpartyAccountId:voucher.counterpartyAccountId,receiptNumber:voucher.receiptNumber,notes:voucher.notes};
  const id=await insertDraft(client,companyId,user,fields,randomUUID(),payload);
  await audit(client,user,"financialDocument.create","financialDocument",id,null,
    await loadDocument(client,companyId,id),companyId);
  await postDraft(client,companyId,id,user);
  await audit(client,user,"financialDocument.post","financialDocument",id,null,
    await loadDocument(client,companyId,id),companyId);
  return id;
}
