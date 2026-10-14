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
export interface MemoFollowerChange {
  id: number;
  revision: number;
  actorName: string;
  createdAt: string;
  beforeFollowers: MemoFollowerInput[];
  afterFollowers: MemoFollowerInput[];
}
export const memoPageReferenceSchema = z.object({
  pageKey: z.string().regex(/^company\.[a-z-]+$/).max(100),
  recordId: z.number().int().positive().max(2147483647).nullable(),
}).strict();
export type MemoPageReference = z.infer<typeof memoPageReferenceSchema>;
export const memoLinksSchema = z.object({
  followPage: memoPageReferenceSchema.nullable(),
  referencePage: memoPageReferenceSchema.nullable(),
  itemId: z.number().int().positive().max(2147483647).nullable(),
  accountId: z.number().int().positive().max(2147483647).nullable(),
}).strict();
export type MemoLinksInput = z.infer<typeof memoLinksSchema>;
export const memoLinksUpdateSchema = memoLinksSchema.extend({
  revision: z.number().int().positive(),
}).strict();
export interface MemoVisibleReference {
  pageKey: string;
  recordId: number | null;
  label: string;
  href: string;
}
export interface MemoVisibleEntity {
  id: number;
  label: string;
  href: string;
}
export interface MemoLinkedView {
  revision: number;
  followPage: MemoVisibleReference | null;
  referencePage: MemoVisibleReference | null;
  item: MemoVisibleEntity | null;
  account: MemoVisibleEntity | null;
  hiddenFollowPage: boolean;
  hiddenReferencePage: boolean;
  hiddenItem: boolean;
  hiddenAccount: boolean;
  changes: {revision:number;actorName:string;createdAt:string}[];
}
export interface MemoLinkChoices {
  itemId: number | null;
  accountId: number | null;
  followPage: MemoPageReference | null;
  referencePage: MemoPageReference | null;
}
export const memoOptionValueSchema = z.object({
 definitionId:z.number().int().positive().max(2147483647),
 value:z.union([z.boolean(),z.string().max(2000),z.null()]),
}).strict();
export type MemoOptionValueInput = z.infer<typeof memoOptionValueSchema>;
export const memoOptionsUpdateSchema = z.object({
 revision:z.number().int().positive(),
 values:z.array(memoOptionValueSchema).max(150),
}).strict();
export interface MemoOptionValue {
 definitionId:number;
 value:boolean|string|null;
}
export interface MemoOptionChange {
 revision:number;
 actorName:string;
 createdAt:string;
}
export const memoScheduleInputSchema = z.discriminatedUnion("action", [
 z.object({
  action:z.literal("set"),
  revision:z.number().int().nonnegative(),
  localDate:z.iso.date(),
  localTime:z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).nullable(),
  reason:z.string().trim().min(1).max(2000),
  repeatInterval:z.enum(["none","day","week","month"]),
 }).strict(),
 z.object({
  action:z.literal("cancel"),
  revision:z.number().int().nonnegative(),
  reason:z.string().trim().min(1).max(2000),
 }).strict(),
]);
export type MemoScheduleInput = z.input<typeof memoScheduleInputSchema>;
export type MemoScheduleRepeat = "none"|"day"|"week"|"month";
export interface MemoSchedule {
 revision:number;
 active:boolean;
 dueAt:string;
 localDate:string;
 localTime:string;
 repeatInterval:MemoScheduleRepeat;
 reason:string;
 actorName:string;
 lastTriggeredAt:string|null;
}
export interface MemoScheduleHistory {
 id:number;revision:number;kind:"scheduled"|"changed"|"cancelled"|"due"|"transition"|"repeated";
 actorName:string|null;reason:string;dueAt:string|null;createdAt:string;
}
export interface MemoReminderSettings {
 defaultTime:string;notifySender:boolean;revision:number;
}
export interface MemoReportRow {
 id:number;
 title:string;
 type:MemoType;
 status:MemoStatus;
 senderName:string;
 senderUserId:number;
 currentName:string;
 currentUserId:number;
 currentEmployeeId:number|null;
 createdAt:string;
 assignedAt:string;
 completedAt:string|null;
 dueAt:string|null;
 deferred:boolean;
 ageHours:number;
 assignmentHours:number;
 approvalHours:number;
 executionHours:number;
 assignmentPeriods:{userId:number;name:string;role:"execution"|"approval";hours:number}[];
 returnCount:number;
 approvedExecution:boolean;
}
export interface MemoReportEmployee {
 userId:number;name:string;
 required:number;awaitingApproval:number;deferred:number;
 approvedWork:number;requestedApproval:number;reopened:number;
 oldestRequiredAt:string|null;executionHours:number;approvalHours:number;
}
export interface MemoReportResult {
 items:MemoReportRow[];
 total:number;
 page:number;pageSize:number;
 metrics:{pending:number;awaitingApproval:number;completed:number;deferred:number;averageCompletedHours:number|null;total:number};
 employees:MemoReportEmployee[];
}
export const memoFeatureActionSchema=z.enum(["invoice.sale.create","invoice.purchase.create"]);
export const memoFeatureEffectSchema=z.enum(["monitor","warn","block"]);
export const memoFeatureRuleSchema=z.object({
 name:z.string().trim().min(1).max(200),
 enabled:z.boolean(),
 employeeIds:z.array(z.number().int().positive()).max(100),
 roleIds:z.array(z.number().int().positive()).max(100),
 actionCode:memoFeatureActionSchema,
 effect:memoFeatureEffectSchema,
 minimumCount:z.number().int().min(1).max(100000).nullable(),
 minimumHours:z.number().min(0).max(100000).nullable(),
 matchMode:z.enum(["all","any"]),
 excludeDeferredUntilDue:z.boolean(),
 message:z.string().max(1000),
}).strict().refine(x=>x.minimumCount!==null||x.minimumHours!==null,
 "يجب تحديد شرط العدد أو المدة");
export const memoFeatureRuleUpdateSchema=memoFeatureRuleSchema.safeExtend({
 revision:z.number().int().positive(),
});
export interface MemoFeatureRule extends z.infer<typeof memoFeatureRuleSchema>{
 id:number;companyId:number;revision:number;changedAt:string;
}
export interface MemoFeatureImpact{
 employeeId:number;employeeName:string;pendingCount:number;eligibleCount:number;
 oldestHours:number;matched:boolean;memoIds:number[];
}
export interface MemoFeaturePreview{
 ruleId:number;actionCode:string;effect:string;
 impacted:MemoFeatureImpact[];totalImpacted:number;
}
export const memoCreateSchema = z
  .object({
    title: z.string().trim().min(1, "عنوان المذكرة مطلوب").max(200),
    body: z.string().trim().min(1, "نص المذكرة مطلوب").max(20000),
    recipientEmployeeId: z.number().int().positive().max(2147483647),
    type: memoTypeSchema,
    followers: z.array(memoFollowerSchema).max(100).optional(),
    links: memoLinksSchema.optional(),
    options: z.array(memoOptionValueSchema).max(150).optional(),
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
  schedule: MemoSchedule | null;
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
  scheduleRevision:number;
  scheduleHistory:MemoScheduleHistory[];
  canSchedule:boolean;
  canManageSchedule:boolean;
  events: MemoEvent[];
  followers: MemoFollower[];
  followerRevision: number;
  followerChanges: MemoFollowerChange[];
  links: MemoLinkedView;
  canManageLinks: boolean;
  optionDefinitions: import("./configuration.ts").OptionDefinition[];
  optionValues: MemoOptionValue[];
  optionRevision: number;
  optionChanges: MemoOptionChange[];
  canManageOptions: boolean;
  canManageFollowers: boolean;
  canComment: boolean;
  canReply: boolean;
  canTransfer: boolean;
  canRequestCompletion: boolean;
  canApproveCompletion: boolean;
  canReopenCompletion: boolean;
  canComplete: boolean;
}
export type MemoSummary = Omit<MemoRecord, "body"> & {optionValues?:Record<string,boolean|string|null>};
export interface MemoList extends Page<MemoSummary> {
  optionDefinitions: import("./configuration.ts").OptionDefinition[];
  searchOptions: import("./configuration.ts").OptionDefinition[];
  canViewAll: boolean;
}
