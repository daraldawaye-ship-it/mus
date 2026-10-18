import { z } from "zod";
import type { ChatContext, ChatScope, ChatUser } from "./chat.ts";

const id = z.number().int().positive().max(2_147_483_647);
const context = { scope: z.enum(["global", "company"]), companyId: id.optional() };
const validContext = (value: ChatContext) => value.scope === "company"
  ? value.companyId !== undefined : value.companyId === undefined;
const cleanText = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !value.includes("\u0000"), "النص يحتوي على محرف غير صالح");
const ids = (max: number) => z.array(id).max(max)
  .transform(values => [...new Set(values)].sort((a, b) => a - b));
export const chatGroupCreateSchema = z.object({
  ...context, clientGroupId: z.uuid().transform(value => value.toLowerCase()),
  name: cleanText(120), memberIds: ids(49).refine(values => values.length > 0, "اختر عضوًا آخر على الأقل"),
}).strict().refine(validContext, "حدد الشركة لدردشة الشركة فقط");
export const chatGroupUpdateSchema = z.object({
  ...context, revision: id, name: cleanText(120).optional(),
  addMemberIds: ids(49).optional(), removeMemberIds: ids(49).optional(), managerId: id.optional(),
}).strict().refine(validContext, "حدد الشركة لدردشة الشركة فقط")
  .refine(value => value.name !== undefined || value.managerId !== undefined ||
    !!value.addMemberIds?.length || !!value.removeMemberIds?.length, "لا توجد تغييرات");
export const chatGroupLeaveSchema = z.object({ ...context, revision: id })
  .strict().refine(validContext, "حدد الشركة لدردشة الشركة فقط");
export const chatGroupSendSchema = z.object({
  ...context, membershipRevision: id,
  clientMessageId: z.uuid().transform(value => value.toLowerCase()), text: cleanText(4_000),
}).strict().refine(validContext, "حدد الشركة لدردشة الشركة فقط");
export type ChatGroupCreateInput = z.infer<typeof chatGroupCreateSchema>;
export type ChatGroupUpdateInput = z.infer<typeof chatGroupUpdateSchema>;
export type ChatGroupLeaveInput = z.infer<typeof chatGroupLeaveSchema>;
export type ChatGroupSendInput = z.infer<typeof chatGroupSendSchema>;

export interface ChatGroupMember extends ChatUser { joinedAt: string; available: boolean; }
export interface ChatGroupReceipt {
  userId: number; name: string; avatarUrl: string | null; deliveredAt: string | null; readAt: string | null;
}
export interface ChatGroupMessage {
  id: number; groupId: number; clientMessageId: string; senderId: number; senderName: string; senderAvatarUrl: string | null;
  text: string; createdAt: string; membershipRevision: number;
  recipientCount: number; deliveredCount: number; readCount: number;
  deliveredAt: string | null; readAt: string | null;
  receipts: ChatGroupReceipt[];
}
export interface ChatGroup {
  id: number; scope: ChatScope; companyId: number | null; name: string;
  managerId: number; revision: number; membershipRevision: number; memberCount: number;
  createdAt: string; updatedAt: string; lastMessage: ChatGroupMessage | null; unreadCount: number;
}
export interface ChatGroupDetail { group: ChatGroup; members: ChatGroupMember[]; }
