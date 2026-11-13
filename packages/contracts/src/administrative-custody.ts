import { z } from "zod";

export const administrativeCustodyTransferSchema = z.object({
  amount: z.string().trim().regex(/^-?(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,2})?$/),
  notes: z.string().trim().max(1000),
  idempotencyKey: z.string().uuid(),
  expenseKind: z.enum(["medical", "slips", "other"]).optional(),
  doctorId: z.number().int().positive().max(2147483647).optional(),
  slipCount: z.number().int().positive().max(2147483647).optional(),
}).strict().superRefine((value, ctx) => {
  const kind = value.expenseKind ?? "other";
  if (kind !== "other" && (!value.doctorId || value.amount.startsWith("-") || !/[1-9]/.test(value.amount)))
    ctx.addIssue({ code: "custom", message: "اختر الطبيب أو الممرض وأدخل مبلغ صرف موجبًا", path: ["doctorId"] });
  if (kind === "slips" && !value.slipCount)
    ctx.addIssue({ code: "custom", message: "أدخل عدد قصاصات موجبًا صحيحًا", path: ["slipCount"] });
  if ((kind === "other" && value.doctorId !== undefined) || (kind !== "slips" && value.slipCount !== undefined))
    ctx.addIssue({ code: "custom", message: "بيانات المستفيد أو القصاصات لا تطابق نوع الصرف" });
});

export type AdministrativeCustodyTransferInput = z.output<typeof administrativeCustodyTransferSchema>;
