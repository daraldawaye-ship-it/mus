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
export const memoFollowerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("employee"), employeeId: z.number().int().positive(), accessLevel: z.enum(["view", "comment"]) }).strict(),
  z.object({ kind: z.literal("role"), roleId: z.number().int().positive(), accessLevel: z.enum(["view", "comment"]) }).strict(),
]);
export type MemoFollowerInput = z.input<typeof memoFollowerSchema>;
export const memoFollowerCommentSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  idempotencyKey: z.uuid().transform(value => value.toLowerCase()),
}).strict();
export const memoFollowersUpdateSchema = z.object({
  revision: z.number().int().positive(),
  followers: z.array(memoFollowerSchema).max(100),
}).strict();
export interface MemoFollower {
  id: number;
  kind: "employee" | "role";
  employeeId: number | null;
  roleId: number | null;
  name: string;
  accessLevel: "view" | "comment";
  addedBy: number;
  addedAt: string;
}
export interface MemoFollowerRole { id: number; name: string; }
export const memoCreateSchema = z
  .object({
    title: z.string().trim().min(1, "عنوان المذكرة مطلوب").max(200),
    body: z.string().trim().min(1, "نص المذكرة مطلوب").max(20000),
    recipientEmployeeId: z.number().int().positive().max(2147483647),
    type: memoTypeSchema,
    followers: z.array(memoFollowerSchema).max(100).optional(),
    idempotencyKey: z.uuid().transform((value) => value.toLowerCase()),
  })
  .strict();
export type MemoCreateInput = z.input<typeof memoCreateSchema>;
export const memoStatusSchema = z.enum([
  "pending",
  "awaiting_approval",
  "completed",
]);
export type MemoStatus = z.infer<typeof memoStatusSchema>;
export const memoStatusLabels: Record<MemoStatus, string> = {
  pending: "معلقة",
  awaiting_approval: "بانتظار اعتماد المرسل",
  completed: "منجزة",
};
const memoActionFields = {
  body: z.string().trim().min(1, "اكتب الرد أو شرح الإجراء").max(20000),
  revision: z.number().int().positive().max(2147483647),
  idempotencyKey: z.uuid().transform((value) => value.toLowerCase()),
};
export const memoActionSchema = z.discriminatedUnion("action", [
  z.object({ ...memoActionFields, action: z.literal("reply") }).strict(),
  z.object({ ...memoActionFields, action: z.literal("return") }).strict(),
  z
    .object({ ...memoActionFields, action: z.literal("request-completion") })
    .strict(),
  z
    .object({ ...memoActionFields, action: z.literal("approve-completion") })
    .strict(),
  z
    .object({ ...memoActionFields, action: z.literal("reopen-completion") })
    .strict(),
  z.object({ ...memoActionFields, action: z.literal("complete") }).strict(),
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
  status: MemoStatus;
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
  completionRequestedByUserId: number | null;
  completionRequestedByEmployeeId: number | null;
  completionRequestedByName: string | null;
  completionRequestedAt: string | null;
  completedAt: string | null;
  completedByUserId: number | null;
  completedByName: string | null;
}
export interface MemoEvent {
  id: number;
  kind:
    | "created"
    | "read"
    | "reply"
    | "returned"
    | "forwarded"
    | "completion_requested"
    | "completed"
    | "reopened"
    | "follower_comment";
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
  followers: MemoFollower[];
  followerRevision: number;
  canManageFollowers: boolean;
  canComment: boolean;
  canReply: boolean;
  canTransfer: boolean;
  canRequestCompletion: boolean;
  canApproveCompletion: boolean;
  canReopenCompletion: boolean;
  canComplete: boolean;
}
export type MemoSummary = Omit<MemoRecord, "body">;
export interface MemoList extends Page<MemoSummary> {
  canViewAll: boolean;
}
