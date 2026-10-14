import { z } from "zod";
import type { Page } from "./index.ts";

export const memoTypeSchema = z.enum(["task", "inquiry", "review", "approval"]);
export type MemoType = z.infer<typeof memoTypeSchema>;
export const memoTypeLabels: Record<MemoType, string> = {
  task: "تكليف",
  inquiry: "استفسار",
  review: "مراجعة",
  approval: "طلب اعتماد",
};
export const memoCreateSchema = z
  .object({
    title: z.string().trim().min(1, "عنوان المذكرة مطلوب").max(200),
    body: z.string().trim().min(1, "نص المذكرة مطلوب").max(20000),
    recipientEmployeeId: z.number().int().positive().max(2147483647),
    type: memoTypeSchema,
    idempotencyKey: z.uuid().transform((value) => value.toLowerCase()),
  })
  .strict();
export type MemoCreateInput = z.input<typeof memoCreateSchema>;
const memoActionFields = {
  body: z.string().trim().min(1, "اكتب الرد أو سبب التحويل").max(20000),
  revision: z.number().int().positive().max(2147483647),
  idempotencyKey: z.uuid().transform((value) => value.toLowerCase()),
};
export const memoActionSchema = z.discriminatedUnion("action", [
  z.object({ ...memoActionFields, action: z.literal("reply") }).strict(),
  z.object({ ...memoActionFields, action: z.literal("return") }).strict(),
  z
    .object({
      ...memoActionFields,
      action: z.literal("forward"),
      recipientEmployeeId: z.number().int().positive().max(2147483647),
    })
    .strict(),
]);
export type MemoActionInput = z.input<typeof memoActionSchema>;
export interface MemoRecipient {
  id: number;
  userId: number;
  name: string;
}
export interface MemoRecord {
  id: number;
  companyId: number;
  title: string;
  body: string;
  type: MemoType;
  status: "pending";
  revision: number;
  senderUserId: number;
  senderName: string;
  recipientEmployeeId: number;
  recipientUserId: number;
  recipientName: string;
  createdAt: string;
  readAt: string | null;
  recipientReadAt: string | null;
  currentUserId: number;
  currentEmployeeId: number | null;
  currentName: string;
  currentAssignedAt: string;
  currentAssignmentRevision: number;
  currentReadAt: string | null;
}
export interface MemoEvent {
  id: number;
  kind: "created" | "read" | "reply" | "returned" | "forwarded";
  actorUserId: number;
  actorName: string;
  createdAt: string;
  body: string | null;
  targetUserId: number | null;
  targetEmployeeId: number | null;
  targetName: string | null;
  assignmentRevision: number | null;
}
export interface MemoDetail extends MemoRecord {
  events: MemoEvent[];
  canReply: boolean;
  canTransfer: boolean;
}
export type MemoSummary = Omit<MemoRecord, "body">;
export interface MemoList extends Page<MemoSummary> {
  canViewAll: boolean;
}
