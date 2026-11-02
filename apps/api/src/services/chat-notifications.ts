import type { PoolClient } from "pg";
import { emitNotification } from "./notifications.ts";

interface ChatAlert {
  companyId: number | null;
  recipientId: number;
  senderName: string;
  messageId: number;
  groupId?: number;
  groupName?: string;
}
/** Only the intended recipient is notified; message contents stay inside chat. */
export async function notifyChatRecipient(client: PoolClient, input: ChatAlert) {
  const group = input.groupId !== undefined;
  const employee = input.companyId === null ? null :
    (await client.query<{id:number}>(
      "SELECT id FROM employees WHERE company_id=$1 AND user_id=$2 AND active",
      [input.companyId,input.recipientId],
    )).rows[0]?.id ?? null;
  const code=group
    ? (input.companyId===null ? "CHAT_GROUP_GLOBAL" : "CHAT_GROUP_COMPANY")
    : (input.companyId===null ? "CHAT_DIRECT_GLOBAL" : "CHAT_DIRECT_COMPANY");
  const subjectKey=group
    ? "chat-group:"+input.groupId+":message:"+input.messageId
    : "chat-message:"+input.messageId;
  const href=input.companyId===null?"/chat":"/companies/"+input.companyId+"/chat";
  await emitNotification(client, {
    code,companyId:input.companyId,subjectEmployeeId:employee,
    recipientUserId:input.recipientId,subjectUserId:input.recipientId,
    subjectKey,eventKey:code+":"+input.messageId,
    title:group?"رسالة في "+(input.groupName??"المجموعة"):"رسالة من "+input.senderName,
    message:group
      ? input.senderName+" أرسل رسالة جديدة في "+(input.groupName??"المجموعة")+"."
      : input.senderName+" أرسل إليك رسالة خاصة جديدة.",
    href,explicitSubjectOnly:true,
  });
}
