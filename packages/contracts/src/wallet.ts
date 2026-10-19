import { z } from "zod";
import type { Page } from "./index.ts";
import { normalizeDigits, rateSchema } from "./masters.ts";
import { amountSchema } from "./finance.ts";

const id = z.number().int().positive().max(2147483647);
const points = z
  .string()
  .max(100)
  .trim()
  .transform(normalizeDigits)
  .pipe(
    z
      .string()
      .regex(
        /^[0-9]{1,18}$/,
        "أدخل عددًا صحيحًا من النقاط لا يزيد عن 18 رقمًا",
      ),
  )
  .transform((value) => BigInt(value).toString());
const signedManualPoints = z.string().max(100).trim()
  .transform(normalizeDigits)
  .pipe(z.string().regex(/^-?[0-9]{1,18}$/,
    "أدخل عدد نقاط صحيحًا؛ استخدم السالب للخصم"))
  .transform(value => BigInt(value).toString())
  .refine(value => value !== "0", "لا يمكن إدخال صفر");
const reason = z.string().trim().min(1, "اكتب سبب العملية").max(500);
export const rewardRepeatRuleSchema = z.enum([
  "per-document",
  "daily",
  "rolling-seven-days",
  "unlimited",
]);
export type RewardRepeatRule = z.infer<typeof rewardRepeatRuleSchema>;
export const walletAwardSchema = z
  .object({
    employeeId: id,
    points: signedManualPoints,
    reason,
    idempotencyKey: z.uuid(),
  })
  .strict();
export const walletReversalSchema = z
  .object({ entryId: id, reason, idempotencyKey: z.uuid() })
  .strict();
export const pageVisitEventSchema = z
  .object({
    pageKey: z.string().min(1).max(100),
    idempotencyKey: z.uuid(),
  })
  .strict();

export const walletPolicySchema = z
  .object({
    pointValue: rateSchema.nullable(),
    currencyId: id.nullable(),
    expenseAccountId: id.nullable(),
    approvalMode: z.enum(["direct", "approval"]).nullable(),
    revision: id.nullable(),
  })
  .strict();
export const employeeWalletAccountSchema = z
  .object({
    accountId: id.nullable(),
    revision: id.nullable(),
  })
  .strict();
export const walletConversionSchema = z
  .object({
    employeeId: id,
    expectedPoints: z
      .string()
      .trim()
      .transform(normalizeDigits)
      .pipe(z.string().regex(/^[0-9]{1,28}$/))
      .transform((value) => BigInt(value).toString())
      .refine((value) => value !== "0", "لا يوجد رصيد نقاط للتحويل"),
    expectedAmount: amountSchema.refine(
      (value) => value !== "0",
      "مبلغ التحويل يجب أن يكون موجبًا",
    ),
    policyRevision: id,
    accountRevision: id,
    idempotencyKey: z.uuid(),
  })
  .strict();
export const walletConversionDecisionSchema = z
  .object({
    revision: id,
    reason,
    idempotencyKey: z.uuid(),
  })
  .strict();

export interface WalletCurrency {
  id: number;
  code: string;
  name: string;
  decimalPlaces: number;
  active: boolean;
}
export interface WalletAccount {
  id: number;
  code: string;
  name: string;
  active: boolean;
  kind: "group" | "posting";
  category: "asset" | "liability" | "equity" | "income" | "expense";
}
export interface WalletPolicy {
  pointValue: string | null;
  currencyId: number | null;
  expenseAccountId: number | null;
  approvalMode: "direct" | "approval" | null;
  revision: number | null;
  currency: WalletCurrency | null;
  expenseAccount: WalletAccount | null;
}
export interface WalletPolicyDirectory {
  policy: WalletPolicy;
  baseCurrency: WalletCurrency | null;
  employees: { id: number; name: string }[];
}
export interface EmployeeWalletAccount {
  employeeId: number;
  employeeName: string;
  active: boolean;
  accountId: number | null;
  account: WalletAccount | null;
  revision: number | null;
}
export interface WalletConversionPreview {
  employeeId: number;
  points: string;
  pointValue: string | null;
  amount: string | null;
  currency: WalletCurrency | null;
  account: WalletAccount | null;
  approvalMode: "direct" | "approval" | null;
  configurationComplete: boolean;
  policyRevision: number | null;
  accountRevision: number | null;
  canConvert: boolean;
  unavailableReason: string;
}
export interface WalletConversion {
  id: number;
  employeeId: number;
  employeeName: string;
  points: string;
  pointValue: string;
  amount: string;
  currencyId: number;
  currencyCode: string;
  decimalPlaces: number;
  accountId: number;
  accountCode: string;
  accountName: string;
  expenseAccountId: number;
  expenseAccountCode: string;
  expenseAccountName: string;
  approvalMode: "direct" | "approval";
  policyRevision: number;
  accountRevision: number;
  status: "pending" | "posted" | "rejected" | "cancelled";
  revision: number;
  financialDocumentId: number | null;
  financialDocumentNumber: string | null;
  entryId: number | null;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
}
export interface WalletConversionDirectory extends Page<WalletConversion> {
  canManage: boolean;
}

export const rewardTaskSettingsSchema = z
  .object({
    points,
    repeatRule: rewardRepeatRuleSchema,
    enabled: z.boolean(),
    dailyLimit: z.number().int().min(1).max(10000).nullable().default(null),
    roleIds: z
      .array(id)
      .max(100)
      .refine(
        (values) => new Set(values).size === values.length,
        "الأدوار مكررة",
      ),
    pageKey: z.string().min(1).max(100).nullable(),
    revision: id.nullable(),
  })
  .strict();

export interface WalletSummary {
  employeeId: number;
  employeeName: string;
  points: string;
  totalPoints: string;
  reservedPoints: string;
  money: string;
  currencyCode: string;
}
export interface WalletEntry {
  id: number;
  employeeId: number;
  employeeName: string;
  kind: "manual" | "manual_debit" | "automatic" | "reversal" | "conversion" | "attendance" | "clearance";
  attendanceEntryId?: number | null;
  clearanceEarningId?: number | null;
  attendanceRecordId?: number | null;
  points: string;
  money: string;
  reason: string;
  referenceId: number | null;
  invoiceId: number | null;
  financialDocumentId: number | null;
  conversionId: number | null;
  pageKey: string | null;
  taskCode: string | null;
  taskRevision: number | null;
  logicalLineCount: number | null;
  reversedByEntryId: number | null;
  createdAt: string;
  createdByName: string;
}
export interface ClearanceTotal {
  currencyId: number;
  currencyCode: string;
  amount: string;
  lineCount: number;
}
export interface ClearanceHistoryRow {
  id: number;
  invoiceId: number;
  invoiceNumber: string;
  invoiceLineId: number;
  itemName: string;
  documentDate: string;
  currencyCode: string;
  rate: string;
  amount: string;
  createdAt: string;
}
export interface ClearanceReturnReview {
  id: number;
  invoiceId: number;
  invoiceNumber: string;
  originalInvoiceId: number;
  originalInvoiceNumber: string;
  itemName: string;
  documentDate: string;
  currencyCode: string;
  candidateAmount: string;
  originalEmployeeName: string | null;
}
export type WalletTaskPostingStatus = "all" | "posted" | "unposted";
export interface WalletTaskAggregate {
  key: string;
  name: string;
  count: number;
  points: string;
}
export interface WalletTaskDetail {
  entry: WalletEntry;
  countedPoints: string;
  status: "posted" | "unposted" | "mixed";
}
export interface WalletTaskReport {
  tasks: WalletTaskAggregate[];
  totalPoints: string;
  totalCount: number;
  details: WalletTaskDetail[];
  detailTotal: number;
  detailPage: number;
  detailPageSize: number;
}

export interface WalletDirectory extends Page<WalletEntry> {
  wallet: WalletSummary | null;
  employees: { id: number; name: string }[];
  canManage: boolean;
  clearanceTotals: ClearanceTotal[];
  clearanceHistory: ClearanceHistoryRow[];
  pendingReturnReviews: ClearanceReturnReview[];
}
export interface RewardTask {
  code: string;
  name: string;
  description: string;
  implemented: boolean;
  points: string;
  repeatRule: RewardRepeatRule;
  enabled: boolean;
  roleIds: number[];
  pageKey: string | null;
  dailyLimit: number | null;
  revision: number | null;
}
export interface RewardTaskDirectory {
  tasks: RewardTask[];
  roles: { id: number; name: string }[];
  pages: { key: string; name: string }[];
}
