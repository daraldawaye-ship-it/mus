import { z } from "zod";
import { normalizeDigits, normalizeRate } from "./masters.ts";

const identifier = z.number().int().positive().max(2_147_483_647);
export const expectedRecurrences = ["daily", "weekly", "monthly", "once"] as const;
export const expectedExpiryModes = ["carry", "complete"] as const;
export type ExpectedRecurrence = (typeof expectedRecurrences)[number];
export type ExpectedExpiryMode = (typeof expectedExpiryModes)[number];
export const expectedRecurrenceLabels: Record<ExpectedRecurrence, string> = {
  daily: "يومي", weekly: "أسبوعي", monthly: "شهري", once: "مرة واحدة",
};
export const expectedExpiryModeLabels: Record<ExpectedExpiryMode, string> = {
  carry: "تراكمي", complete: "يُنجز بانتهاء التاريخ",
};
export const expectedDateSchema = z.iso.date().refine(value => value >= "0001-01-01", "التاريخ غير صالح");
/** Six calendar months, clamped to the final day of the target month. */
export function expectedEndDateLimit(startDate: string): string {
  expectedDateSchema.parse(startDate);
  const start = new Date(`${startDate}T00:00:00Z`);
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth()+6);
  if (start.getUTCFullYear()>9999) return "9999-12-31";
  const last = new Date(start);
  last.setUTCMonth(last.getUTCMonth()+1);
  last.setUTCDate(0);
  start.setUTCDate(Math.min(day,last.getUTCDate()));
  return start.toISOString().slice(0,10);
}
export const expectedAmountSchema = z.string().trim()
  .transform(value => normalizeDigits(value).replace(/٫/g, "."))
  .pipe(z.string().regex(/^-?\d{1,22}(?:\.\d{1,6})?$/, "المبلغ نص عشري حتى 22 رقمًا صحيحًا و6 كسور"))
  .transform(value => {
    const negative = value.startsWith("-");
    const magnitude = normalizeRate(negative ? value.slice(1) : value);
    return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
  });
export const expectedCardCreateSchema = z.object({
  accountId: identifier,
  cashAccountId: identifier.nullable().default(null),
  section: z.string().trim().max(120).default(""),
  amount: expectedAmountSchema,
  description: z.string().trim().max(2000).default(""),
  recurrence: z.enum(expectedRecurrences),
  weekday: z.number().int().min(0).max(6).optional(),
  monthDay: z.number().int().min(1).max(31).optional(),
  onceDate: expectedDateSchema.optional(),
  startDate: expectedDateSchema.optional(),
  endDate: expectedDateSchema,
  expiryMode: z.enum(expectedExpiryModes),
  idempotencyKey: z.uuid(),
}).strict().superRefine((input, context) => {
  for (const [kind, field] of [["weekly", "weekday"], ["monthly", "monthDay"], ["once", "onceDate"]] as const) {
    if (input.recurrence === kind && input[field] === undefined)
      context.addIssue({code: "custom", path: [field], message: "حدد موعد الترحيل"});
    if (input.recurrence !== kind && input[field] !== undefined)
      context.addIssue({code: "custom", path: [field], message: "التحديد لا يطابق نوع الترحيل"});
  }
  if (input.onceDate && input.onceDate > input.endDate)
    context.addIssue({code: "custom", path: ["endDate"], message: "تاريخ النهاية يسبق الموعد المحدد"});
  if (input.startDate && expectedDateSchema.safeParse(input.startDate).success) {
    if (input.endDate < input.startDate)
      context.addIssue({code: "custom", path: ["endDate"], message: "تاريخ النهاية يسبق تاريخ البداية"});
    if (input.endDate > expectedEndDateLimit(input.startDate))
      context.addIssue({code: "custom", path: ["endDate"], message: "ينتهي بعد لا يتجاوز ستة أشهر من يبدأ من"});
    if (input.onceDate && input.onceDate < input.startDate)
      context.addIssue({code: "custom", path: ["onceDate"], message: "الموعد المحدد يسبق تاريخ البداية"});
  }
});
export const expectedCardLifecycleSchema = z.object({
  revision: identifier,
  action: z.enum(["archive", "restore"]),
}).strict();
export type ExpectedCardLifecycle = z.output<typeof expectedCardLifecycleSchema>;
export const expectedMovementPatchSchema = z.object({
  revision: identifier,
  date: expectedDateSchema,
  amount: expectedAmountSchema,
  description: z.string().trim().max(2000),
}).strict();
export const expectedMovementCompleteSchema = z.object({revision: identifier}).strict();
export type ExpectedCardCreateInput = z.input<typeof expectedCardCreateSchema>;
export type ExpectedCardCreate = z.output<typeof expectedCardCreateSchema>;
export type ExpectedMovementPatchInput = z.input<typeof expectedMovementPatchSchema>;
export type ExpectedMovementPatch = z.output<typeof expectedMovementPatchSchema>;
export interface ExpectedCard {
  id: number; companyId: number; accountId: number; accountName: string; accountCode: string;
  cashAccountId: number | null; cashAccountName: string | null; cashAccountCode: string | null;
  section: string; currencyCode: string; amount: string; description: string; recurrence: ExpectedRecurrence;
  weekday: number | null; monthDay: number | null; onceDate: string | null;
  startDate: string; endDate: string; expiryMode: ExpectedExpiryMode;
  movementCount: number; pendingCount: number; completedCount: number; createdAt: string;
  createdById: number; createdByName: string;
  archivedAt: string | null; lifecycleRevision: number; archivedMovementCount: number; purgedMovementCount: number;
}
export interface ExpectedMovement {
  id: number; companyId: number; cardId: number; accountId: number; accountName: string; accountCode: string;
  section: string; currencyCode: string; date: string; originalDate: string; amount: string; description: string;
  status: "pending" | "completed"; completedAmount: string | null; completedAt: string | null;
  completionSource: "manual" | "automatic" | null; revision: number;
  originalAmount: string; originalDescription: string; expiryMode: ExpectedExpiryMode; updatedAt: string;
  postedById: number | null; postedByName: string; postedAt: string;
  completedById: number | null; completedByName: string;
  cardArchived: boolean;
}
