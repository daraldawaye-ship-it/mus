import { z } from "zod";

export const slipReceiptSchema = z.object({
  count: z.number().int().min(0).max(2147483647),
  idempotencyKey: z.string().uuid(),
}).strict();
export type SlipReceiptInput = z.output<typeof slipReceiptSchema>;
export type SlipReceiptResult = { id: number; expected: string; received: string; difference: string };
export type SlipMovement = {
  id: string; kind: "transfer" | "receipt" | "variance";
  createdAt: string; actor: string; description: string;
  positive: string; negative: string; balance: string;
};
export type SlipLedger = {
  items: SlipMovement[]; total: number; page: number; pageSize: number;
  pending: { count: number; total: string };
  totals: { transferred: string; received: string; shortage: string; surplus: string; balance: string };
};
