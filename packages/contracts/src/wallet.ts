import { z } from "zod";
import type { Page } from "./index.ts";
import { normalizeDigits } from "./masters.ts";

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
    points: points.refine(
      (value) => value !== "0",
      "يجب أن تكون النقاط أكبر من صفر",
    ),
    reason,
    idempotencyKey: z.uuid(),
  })
  .strict();
export const walletReversalSchema = z
  .object({ entryId: id, reason, idempotencyKey: z.uuid() })
  .strict();
export const pageVisitEventSchema = z.object({
  pageKey: z.string().min(1).max(100),
  idempotencyKey: z.uuid(),
}).strict();

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
  money: string;
  currencyCode: string;
}
export interface WalletEntry {
  id: number;
  employeeId: number;
  employeeName: string;
  kind: "manual" | "automatic" | "reversal";
  points: string;
  money: string;
  reason: string;
  referenceId: number | null;
  invoiceId: number | null;
  financialDocumentId: number | null;
  pageKey: string | null;
  taskCode: string | null;
  taskRevision: number | null;
  logicalLineCount: number | null;
  reversedByEntryId: number | null;
  createdAt: string;
  createdByName: string;
}
export interface WalletDirectory extends Page<WalletEntry> {
  wallet: WalletSummary | null;
  employees: { id: number; name: string }[];
  canManage: boolean;
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
