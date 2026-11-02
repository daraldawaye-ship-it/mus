import { createHash } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, parse } from "./http.ts";
import { HttpError, deny } from "./errors.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { effectiveTemplate, emitNotification } from "./services/notifications.ts";
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
/** Independent notifications; no chat or chat permissions are used. */
export const quickNotificationTypes = {
  system_change: {code:"QUICK_SYSTEM_CHANGE",title:"طلب تعديل النظام"},
  present_employees: {code:"QUICK_PRESENT_EMPLOYEES",title:"رسالة إلى جميع المحضّرين"},
  all_employees: {code:"QUICK_ALL_EMPLOYEES",title:"رسالة إلى جميع الموظفين"},
  app_manager: {code:"QUICK_APP_MANAGER",title:"رسالة إلى مسؤول التطبيق"},
} as const;

/** Recipients and notifications share one atomic transaction, with one
 * idempotency key per sender and request. */
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
      let recipients: {userId:number;employeeId:number|null}[];
      if (input.kind === "system_change" || input.kind === "app_manager") {
        // The management recipients are the real platform owners/admins.
        const rows=(await client.query(
          "SELECT id FROM users WHERE (owner OR kind='admin') AND NOT archived AND NOT suspended AND id<>$1 ORDER BY id LIMIT 251",
          [user.id],
        )).rows;
        recipients=rows.map(row=>({userId:row.id as number,employeeId:null}));
      } else {
        // "Present" = OPEN attendance check-in, NOT web activity/online.
        const rows=(await client.query(
          ["SELECT DISTINCT ON (e.user_id) e.user_id,e.id AS employee_id FROM employees e JOIN users u ON u.id=e.user_id",
           "WHERE e.company_id=$1 AND e.active AND e.user_id<>$2",
           "AND NOT u.archived AND NOT u.suspended",
           "AND ($3::boolean=false OR EXISTS (SELECT 1 FROM attendance_records ar",
           "WHERE ar.company_id=e.company_id AND ar.employee_id=e.id AND ar.checked_out_at IS NULL))",
           "ORDER BY e.user_id,e.id LIMIT 251"].join(" "),
          [input.companyId,user.id,input.kind === "present_employees"],
        )).rows;
        recipients=rows.map(row=>({userId:row.user_id as number,employeeId:row.employee_id as number}));
      }
      if (recipients.length>250)
        throw new HttpError(409,"too_many_recipients","عدد المستلمين يتجاوز 250؛ لم يُرسل أي شيء، راجع الإدارة");
      if (!recipients.length)
        throw new HttpError(409,"no_recipients","لا يوجد مستلمون مؤهلون؛ لم تُرسل الرسالة");
      const type=quickNotificationTypes[input.kind];
      const companyScoped=input.kind==="present_employees"||input.kind==="all_employees";
      const template=await effectiveTemplate(client,companyScoped?input.companyId!:null,type.code);
      if(!template?.implemented || !template.enabled)
        throw new HttpError(409,"notifications_disabled","نوع التنبيه غير مفعّل، ولم تُرسل أي رسالة");
      await client.query(
        ["INSERT INTO user_quick_messages",
         "(user_id,client_request_id,kind,company_id,payload_hash,recipient_ids)",
         "VALUES($1,$2,$3,$4,$5,$6::integer[])"].join(" "),
        [user.id,input.clientRequestId,input.kind,input.companyId??null,digest,recipients.map(r=>r.userId)],
      );
      const destination=companyScoped
        ? "/companies/"+input.companyId+"/notifications?state=all&grouped=0&code="+type.code
        : "/notifications?state=all&grouped=0&code="+type.code;
      const notificationText="من "+user.displayName+
        (input.kind==="system_change"?" — "+companyName:"")+
        ":\n"+input.text;
      for (const recipient of recipients) {
        // Existing notification system authorizes the exact user and respects
        // its subscriptions; no chat thread, messages or chat page involved.
        await emitNotification(client,{
          code:type.code,companyId:companyScoped?input.companyId!:null,
          ...(companyScoped?{subjectEmployeeId:recipient.employeeId}:{subjectUserId:recipient.userId}),
          recipientUserId:recipient.userId,explicitSubjectOnly:true,
          subjectKey:"quick:"+user.id+":"+input.clientRequestId,
          eventKey:"quick:"+user.id+":"+input.clientRequestId,
          title:type.title,
          message:notificationText,
          href:destination,
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
