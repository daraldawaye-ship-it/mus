import { z } from "zod";

const chatId = z.number().int().positive().max(2_147_483_647);
export const chatScopes = ["global", "company"] as const;
export type ChatScope = (typeof chatScopes)[number];
export interface ChatContext {
  scope: ChatScope;
  companyId?: number;
}
const contextFields = {
  scope: z.enum(chatScopes),
  companyId: chatId.optional(),
};
function validContext(value: ChatContext): boolean {
  return value.scope === "company"
    ? value.companyId !== undefined
    : value.companyId === undefined;
}
export const chatContextSchema = z.object(contextFields).strict().refine(
  validContext,
  "حدد الشركة لدردشة الشركة فقط",
);
export const chatSendSchema = z.object({
  ...contextFields,
  clientMessageId: z.uuid().transform(value => value.toLowerCase()),
  text: z.string().trim().min(1).max(4_000)
    .refine(value => !value.includes("\u0000"), "النص يحتوي على محرف غير صالح"),
}).strict().refine(validContext, "حدد الشركة لدردشة الشركة فقط");
const messageIds = z.array(chatId).max(100)
  .transform(values => [...new Set(values)].sort((a, b) => a - b));
/** Acknowledgments name exact messages. Opening a list never implies reading. */
export const chatReceiptSchema = z.object({
  ...contextFields,
  deliveredMessageIds: messageIds.default([]),
  readMessageIds: messageIds.default([]),
}).strict().refine(validContext, "حدد الشركة لدردشة الشركة فقط")
  .refine(value => value.deliveredMessageIds.length + value.readMessageIds.length > 0,
    "حدد الرسائل المستلمة أو المعروضة");
export type ChatSendInput = z.infer<typeof chatSendSchema>;
export type ChatReceiptInput = z.infer<typeof chatReceiptSchema>;

/** Deliberately excludes private contact and administration fields. */
export interface ChatUser { id: number; name: string; }
export interface ChatMessage {
  id: number;
  clientMessageId: string;
  senderId: number;
  recipientId: number;
  text: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}
export interface ChatConversation {
  peer: ChatUser;
  lastMessage: ChatMessage;
  unreadCount: number;
}
export interface ChatPage<T> {
  items: T[];
  nextCursor: string | null;
}
