import { createHash } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, parse } from "./http.ts";
import { HttpError, deny } from "./errors.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { sendChatMessage } from "./services/chat.ts";
import { audit } from "./services/audit.ts";

export const quickMessageSchema = z.object({
  kind: z.enum(["system_change", "present_employees", "all_employees", "app_manager", "private_note"]),
  companyId: z.number().int().positive().max(2147483647).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(3500).refine(value => !value.includes("\u0000")),
  clientRequestId: z.uuid(),
}).strict().superRefine((value, context) => {
  if (["system_change", "present_employees", "all_employees"].includes(value.kind) && !value.companyId)
    context.addIssue({ code: "custom", path: ["companyId"], message: "اختر الشركة أولًا" });
  if (value.kind === "private_note" && !value.title)
    context.addIssue({ code: "custom", path: ["title"], message: "اكتب عنوان المذكرة الشخصية" });
});
function messageIdFor(requestId: string, peerId: number): string {
  const bytes = createHash("sha256").update("alraesy-quick-message:" + requestId + ":" + peerId).digest().subarray(0,16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join("-");
}

/** Use chat service so the EXISTING notifications and access checks run once
 * per recipient. Entire batch is atomic and idempotent via UUID.
 */
export function quickMessagesRoutes(pool: Pool): Router {
  const router = Router();
  router.post("/quick-messages", handler(async (req,res) => {
    const input = parse(quickMessageSchema, req.body);
    const result = await transaction(pool, async client => {
      const user = await currentActor(client, actor(req), false);
      if (user.suspended) deny("هذا الحساب موقوف");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["quick-message:" + user.id + ":" + input.clientRequestId]);

      if (input.kind === "private_note") {
        const existing=(await client.query(
          "SELECT id,title,body FROM user_private_notes WHERE user_id=$1 AND client_request_id=$2",
          [user.id,input.clientRequestId],
        )).rows[0];
        if (existing) {
          if (existing.title !== input.title || existing.body !== input.text)
            throw new HttpError(409,"idempotency_conflict","تغيرت بيانات المذكرة المحفوظة");
          return {saved:true,id:existing.id,recipients:0};
        }
        const row=(await client.query(
          "INSERT INTO user_private_notes(user_id,client_request_id,title,body) VALUES($1,$2,$3,$4) RETURNING id",
          [user.id,input.clientRequestId,input.title,input.text],
        )).rows[0];
        // Never copy private note title or content to general audit.
        await audit(client,user,"quick.privateNoteCreate","user_private_note",row.id,null,{ownerId:user.id},null);
        return {saved:true,id:row.id,recipients:0};
      }

      const digest=createHash("sha256").update(JSON.stringify({
        kind:input.kind,companyId:input.companyId??null,title:input.title??null,text:input.text,
      })).digest("hex");
      const previous=(await client.query(
        "SELECT payload_hash,recipient_ids FROM user_quick_messages WHERE user_id=$1 AND client_request_id=$2",
        [user.id,input.clientRequestId],
      )).rows[0];
      if (previous) {
        if (previous.payload_hash!==digest)
          throw new HttpError(409,"idempotency_conflict","تغيرت الرسالة بعد إرسالها؛ ابدأ رسالة جديدة");
        return {sent:true,recipients:(previous.recipient_ids as number[]).length};
      }

      let companyName="";
      if (input.kind !== "app_manager") {
        await companyAccess(client,user,input.companyId!);
        companyName=(await client.query("SELECT name FROM companies WHERE id=$1",[input.companyId])).rows[0]?.name ?? "";
      }
      let recipients: number[];
      let message: string;
      let scope: "global"|"company";
      if (input.kind === "system_change" || input.kind === "app_manager") {
        // The management recipients are the real platform owners/admins.
        const rows=(await client.query(
          "SELECT id FROM users WHERE (owner OR kind='admin') AND NOT archived AND NOT suspended AND id<>$1 ORDER BY id LIMIT 251",
          [user.id],
        )).rows;
        recipients=rows.map(row=>row.id as number);
        scope="global";
        message=input.kind === "system_change"
          ? "طلب تعديل النظام — " + companyName + " (#" + input.companyId + ")\n" + input.text
          : "رسالة إلى مسؤول التطبيق\n" + input.text;
      } else {
        // "Present" = OPEN attendance check-in, NOT web activity/online.
        const rows=(await client.query(
          ["SELECT DISTINCT e.user_id FROM employees e JOIN users u ON u.id=e.user_id",
           "WHERE e.company_id=$1 AND e.active AND e.user_id<>$2",
           "AND NOT u.archived AND NOT u.suspended",
           "AND ($3::boolean=false OR EXISTS (SELECT 1 FROM attendance_records ar",
           "WHERE ar.company_id=e.company_id AND ar.employee_id=e.id AND ar.checked_out_at IS NULL))",
           "ORDER BY e.user_id LIMIT 251"].join(" "),
          [input.companyId,user.id,input.kind === "present_employees"],
        )).rows;
        recipients=rows.map(row=>row.user_id as number);
        scope="company";
        message=input.text;
      }
      if (recipients.length>250)
        throw new HttpError(409,"too_many_recipients","عدد المستلمين يتجاوز 250؛ لم يُرسل أي شيء، راجع الإدارة");
      if (!recipients.length)
        throw new HttpError(409,"no_recipients","لا يوجد مستلمون مؤهلون؛ لم تُرسل الرسالة");
      await client.query(
        ["INSERT INTO user_quick_messages",
         "(user_id,client_request_id,kind,company_id,payload_hash,recipient_ids)",
         "VALUES($1,$2,$3,$4,$5,$6::integer[])"].join(" "),
        [user.id,input.clientRequestId,input.kind,input.companyId??null,digest,recipients],
      );
      for (const peerId of recipients) {
        await sendChatMessage(client,user,peerId,{
          scope,...(scope==="company"?{companyId:input.companyId}:{}),
          clientMessageId:messageIdFor(input.clientRequestId,peerId),text:message,
        });
      }
      await audit(client,user,"quick.broadcast","quick_message",null,null,
        {type:input.kind,recipients:recipients.length},input.companyId??null);
      return {sent:true,recipients:recipients.length};
    });
    res.json(result);
  }));
  return router;
}
