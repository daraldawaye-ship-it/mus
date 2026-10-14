import { z } from "zod";
import { normalizeDigits, normalizeRate } from "./masters.ts";

const id = z.number().int().positive().max(2_147_483_647);
export const documentKinds = ["journal", "receipt", "payment"] as const;
export const documentStatuses = ["draft", "posted", "reversed"] as const;
export type FinancialDocumentKind = (typeof documentKinds)[number];
export type FinancialDocumentStatus = (typeof documentStatuses)[number];
export const documentKindLabels: Record<FinancialDocumentKind, string> = {
  journal: "قيد يومية",
  receipt: "سند قبض",
  payment: "سند صرف",
};
export const documentStatusLabels: Record<FinancialDocumentStatus, string> = {
  draft: "مسودة",
  posted: "مرحل",
  reversed: "معكوس",
};
export const amountSchema = z
  .string()
  .trim()
  .transform((value) => normalizeDigits(value).replace(/٫/g, "."))
  .pipe(
    z
      .string()
      .regex(
        /^\d{1,22}(?:\.\d{1,6})?$/,
        "المبلغ نص عشري موجب أو صفر حتى 22 رقمًا صحيحًا و6 كسور",
      ),
  )
  .transform(normalizeRate);
export const documentDateSchema = z.iso
  .date()
  .refine((value) => Number(value.slice(0, 4)) >= 1, "تاريخ المستند غير صالح");
export const financialLineSchema = z
  .object({
    accountId: id,
    debit: amountSchema,
    credit: amountSchema,
    description: z.string().trim().max(500).default(""),
  })
  .strict();
const documentFields = z
  .object({
    kind: z.enum(documentKinds),
    documentDate: documentDateSchema,
    currencyId: id,
    branchId: id.nullable().default(null),
    cashAccountId: id.nullable().default(null),
    supplierReceiptNumber: z.string().trim().max(100).default(""),
    description: z.string().trim().max(1000).default(""),
    lines: z.array(financialLineSchema).min(2).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== "payment" && value.supplierReceiptNumber)
      context.addIssue({ code: "custom", path: ["supplierReceiptNumber"], message: "رقم وصل المورد مخصص لسندات الصرف فقط" });
  });
export const financialDocumentSchema = documentFields
  .extend({ idempotencyKey: z.uuid() })
  .strict();
export const financialDocumentPatchSchema = documentFields
  .extend({ revision: z.number().int().positive().max(2_147_483_647) })
  .strict();
export const financialPostSchema = z
  .object({ revision: z.number().int().positive().max(2_147_483_647) })
  .strict();
export const financialReverseSchema = z
  .object({
    reason: z.string().trim().min(1, "سبب العكس مطلوب").max(1000),
    documentDate: documentDateSchema,
    idempotencyKey: z.uuid(),
  })
  .strict();
export type FinancialDocumentInput = z.input<typeof financialDocumentSchema>;
export type FinancialDocumentPatchInput = z.input<
  typeof financialDocumentPatchSchema
>;
export interface FinancialLine {
  id: number;
  lineNumber: number;
  accountId: number;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  baseDebit: string | null;
  baseCredit: string | null;
  description: string;
}
export interface FinancialDocument {
  id: number;
  companyId: number;
  number: string;
  kind: FinancialDocumentKind;
  status: FinancialDocumentStatus;
  revision: number;
  documentDate: string;
  currencyId: number;
  currencyCode: string;
  currencyName: string;
  decimalPlaces: number;
  baseCurrencyId: number | null;
  baseCurrencyCode: string | null;
  baseDecimalPlaces: number | null;
  exchangeRate: string | null;
  exchangeRateId: number | null;
  exchangeRateSource: string | null;
  branchId: number | null;
  branchName: string | null;
  cashAccountId: number | null;
  supplierReceiptNumber: string;
  description: string;
  lines: FinancialLine[];
  totalDebit: string;
  totalCredit: string;
  totalBaseDebit: string | null;
  totalBaseCredit: string | null;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  postedBy: number | null;
  postedAt: string | null;
  reversalDocumentId: number | null;
  reversesDocumentId: number | null;
}
export interface AccountBalance {
  id: number;
  accountId: number;
  accountCode: string;
  accountName: string;
  normalSide: "debit" | "credit";
  baseCurrencyCode: string | null;
  debit: string;
  credit: string;
  balance: string;
}
export interface AccountLedgerLine {
  id: number;
  documentId: number;
  documentNumber: string;
  documentDate: string;
  kind: FinancialDocumentKind;
  status: FinancialDocumentStatus;
  description: string;
  currencyId: number;
  currencyCode: string;
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
  runningBalance: string;
  reversesDocumentId: number | null;
}
export interface AccountLedgerTotals {
  openingBalance: string;
  debit: string;
  credit: string;
  closingBalance: string;
  baseCurrencyCode: string | null;
}
export const financeCatalog = {
  documentKinds,
  documentStatuses,
  documentKindLabels,
  documentStatusLabels,
};
