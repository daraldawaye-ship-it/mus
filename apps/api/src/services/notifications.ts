import type { PoolClient, QueryResultRow } from "pg";
import type {
  NotificationRecord,
  NotificationTemplate,
} from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";
import { HttpError } from "../errors.ts";
import { memoFollowerSql } from "./memo-followers.ts";

export const memoNotificationCodes = ["MEMO_RECEIVED", "MEMO_REPLY", "MEMO_APPROVAL", "MEMO_COMPLETED", "MEMO_FOLLOW", "MEMO_DUE"];

export const templateQuery = `SELECT t.*,s.id AS setting_id,s.revision,
 COALESCE(s.importance,t.default_importance) AS importance,COALESCE(s.enabled,t.implemented) AS enabled,
 COALESCE(s.can_snooze,true) AS can_snooze,COALESCE(s.allow_repeat,false) AS allow_repeat,
 COALESCE(s.repeat_interval,'none') AS repeat_interval,COALESCE(s.notify_managers,t.default_notify_managers) AS notify_managers,
 COALESCE(s.notify_subject,true) AS notify_subject,COALESCE(s.role_ids,'{}'::integer[]) AS role_ids,COALESCE(s.employee_ids,'{}'::integer[]) AS employee_ids
 FROM notification_templates t LEFT JOIN notification_settings s ON s.code=t.code AND s.company_id IS NOT DISTINCT FROM $1::integer`;
export const templateDTO = (r: QueryResultRow): NotificationTemplate => ({
  code: r.code,
  name: r.name,
  category: r.category,
  scope: r.scope,
  description: r.description,
  implemented: r.implemented,
  canDisable: r.can_disable,
  importance: r.importance,
  enabled: r.enabled,
  canSnooze: r.can_snooze,
  allowRepeat: r.allow_repeat,
  repeatInterval: r.repeat_interval,
  notifyManagers: r.notify_managers,
  notifySubject: r.notify_subject,
  roleIds: r.role_ids,
  employeeIds: r.employee_ids,
  revision: r.revision ?? null,
});
export async function effectiveTemplate(
  client: PoolClient,
  companyId: number | null,
  code: string,
) {
  const r = (
    await client.query(
      templateQuery +
        " WHERE t.code=$2 AND t.scope=CASE WHEN $1::integer IS NULL THEN 'public' ELSE 'company' END",
      [companyId, code],
    )
  ).rows[0];
  return r ? templateDTO(r) : null;
}
export const notificationSelect = `SELECT n.*,COALESCE(s.can_snooze,true) AS can_snooze,COALESCE(s.allow_repeat,false) AS allow_repeat,
 COALESCE(s.enabled,t.implemented) AS template_enabled,t.implemented
 FROM notifications n JOIN notification_templates t ON t.code=n.code
 LEFT JOIN notification_settings s ON s.code=n.code AND s.company_id IS NOT DISTINCT FROM n.company_id`;
// Recipient identity is necessary but not sufficient: membership and current follow grants are checked again.
export const inboxFilter = `n.recipient_user_id=$1 AND (
 (n.company_id IS NULL AND COALESCE((SELECT enabled FROM page_settings WHERE company_id IS NULL AND page_key='public.notifications'),true)) OR n.company_id=$2::integer)
 AND (n.company_id IS NULL OR $4::boolean OR n.assigned
 OR (COALESCE(s.notify_subject,true) AND n.subject_employee_id=$3::integer)
 OR $3::integer=ANY(COALESCE(s.employee_ids,'{}'::integer[]))
 OR EXISTS(SELECT 1 FROM employee_role_assignments a JOIN company_roles r ON r.company_id=a.company_id AND r.id=a.role_id AND r.active
 WHERE a.company_id=n.company_id AND a.employee_id=$3 AND a.active AND a.role_id=ANY(COALESCE(s.role_ids,'{}'::integer[]))))
 AND (n.code NOT IN ('MEMO_RECEIVED','MEMO_REPLY','MEMO_APPROVAL','MEMO_COMPLETED','MEMO_FOLLOW','MEMO_DUE') OR n.subject_employee_id=$3::integer OR $4::boolean)
 AND (n.code<>'MEMO_DUE' OR EXISTS(
   SELECT 1 FROM memos due_m WHERE due_m.company_id=n.company_id
   AND n.subject_key=('memo:'||due_m.id::text)
   AND due_m.status<>'completed' AND due_m.current_user_id=$1
   AND (due_m.current_employee_id IS NULL OR due_m.current_employee_id=$3::integer)
 ))
 AND (n.code<>'MEMO_FOLLOW' OR $4::boolean OR EXISTS(
   SELECT 1 FROM memos m
   WHERE m.company_id=n.company_id AND n.subject_key=('memo:' || m.id::text)
   AND ${memoFollowerSql("m", "$3")}
 ))
 -- Chat group notifications follow current group membership (including a
 -- member leaving and rejoining after a previous message).
 AND (n.code NOT IN ('CHAT_GROUP_GLOBAL','CHAT_GROUP_COMPANY') OR EXISTS(
   SELECT 1 FROM chat_group_members gm
   JOIN chat_groups g ON g.id=gm.group_id
   WHERE gm.user_id=$1 AND gm.left_at IS NULL
   AND gm.group_id::text=split_part(n.subject_key,':',2)
   AND g.company_id IS NOT DISTINCT FROM n.company_id
 ))`;
export const notificationDTO = (
  r: QueryResultRow,
  general: boolean,
): NotificationRecord => ({
  id: r.id,
  code: r.code,
  title: r.title,
  message: r.message,
  importance: r.importance,
  companyId: r.company_id,
  createdAt: r.created_at.toISOString(),
  readAt: r.read_at?.toISOString() ?? null,
  completedAt: r.completed_at?.toISOString() ?? null,
  snoozedUntil: r.snoozed_until?.toISOString() ?? null,
  repeatInterval: r.repeat_interval,
  reminderCount: r.reminder_count,
  revision: r.revision,
  subjectEmployeeId: r.subject_employee_id ?? null,
  groupCount: Number(r.group_count ?? 1),
  groupUnread: Number(r.group_unread ?? (r.read_at ? 0 : 1)),
  canSnooze: !r.completed_at && r.can_snooze,
  canRepeat:
    !r.completed_at && r.allow_repeat && r.template_enabled && r.implemented,
  canAssign: !r.completed_at && general && r.company_id !== null && !memoNotificationCodes.includes(r.code),
  href: r.href ?? null,
});
export async function nextReminder(
  client: PoolClient,
  interval: string,
  from: Date = new Date(),
) {
  if (interval === "none") return null;
  const value =
    interval === "day"
      ? "1 day"
      : interval === "week"
        ? "7 days"
        : interval === "month"
          ? "1 month"
          : null;
  if (!value)
    throw new HttpError(400, "invalid_repeat", "فترة التكرار غير صالحة");
  return (
    await client.query(
      "SELECT (($1::timestamptz AT TIME ZONE 'Asia/Aden')+$2::interval) AT TIME ZONE 'Asia/Aden' AS next",
      [from, value],
    )
  ).rows[0].next as Date;
}
export async function emitNotification(
  client: PoolClient,
  input: {
    code: string;
    companyId: number | null;
    subjectEmployeeId?: number | null;
    subjectUserId?: number | null;
    // Exact company recipient, including an owner without an employee record.
    // Only used with explicitSubjectOnly; active membership is still checked.
    recipientUserId?: number;
    subjectKey: string;
    eventKey: string;
    message: string;
    href?: string | null;
    title?: string;
    // Individually addressed records must never go to configured followers
    // who may have no permission to read the underlying record.
    explicitSubjectOnly?: boolean;
  },
) {
  const template = await effectiveTemplate(client, input.companyId, input.code);
  if (!template?.implemented || !template.enabled) return;
  let recipients: number[] = [];
  if (input.companyId !== null) {
    if (
      input.subjectEmployeeId &&
      !(
        await client.query(
          "SELECT 1 FROM employees WHERE company_id=$1 AND id=$2",
          [input.companyId, input.subjectEmployeeId],
        )
      ).rowCount
    )
      throw new Error("Invalid notification subject");
    recipients = input.explicitSubjectOnly
      ? (
          await client.query(
            `SELECT u.id FROM users u LEFT JOIN employees e ON e.user_id=u.id AND e.company_id=$1 AND e.active
             WHERE NOT u.archived AND
              (($3::integer IS NULL AND e.id=$2) OR
               (u.id=$3 AND ((e.id=$2) OR ($2::integer IS NULL AND u.owner))))`,
            [input.companyId, input.subjectEmployeeId ?? null, input.recipientUserId ?? null],
          )
        ).rows.map((r) => r.id)
      : (
      await client.query(
        `SELECT DISTINCT u.id FROM users u LEFT JOIN employees e ON e.user_id=u.id AND e.company_id=$1 AND e.active
   WHERE NOT u.archived AND (($2::boolean AND (u.owner OR e.is_general_manager)) OR ($3::boolean AND e.id=$4) OR e.id=ANY($5::integer[])
   OR EXISTS(SELECT 1 FROM employee_role_assignments a JOIN company_roles r ON r.company_id=a.company_id AND r.id=a.role_id AND r.active WHERE a.company_id=$1 AND a.employee_id=e.id AND a.active AND a.role_id=ANY($6::integer[]))) ORDER BY u.id`,
        [
          input.companyId,
          template.notifyManagers,
          template.notifySubject,
          input.subjectEmployeeId ?? null,
          template.employeeIds,
          template.roleIds,
        ],
      )
    ).rows.map((r) => r.id);
  } else {
    recipients = (
      await client.query(
        "SELECT id FROM users WHERE NOT archived AND (($1::boolean AND owner) OR ($2::boolean AND id=$3)) ORDER BY id",
        [
          template.notifyManagers,
          template.notifySubject,
          input.subjectUserId ?? null,
        ],
      )
    ).rows.map((r) => r.id);
  }
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]
    .now as Date;
  const next = await nextReminder(
    client,
    template.allowRepeat ? template.repeatInterval : "none",
    now,
  );
  for (const userId of recipients) {
    const created = (
      await client.query(
        `INSERT INTO notifications(company_id,code,recipient_user_id,subject_employee_id,subject_key,event_key,title,message,importance,href,repeat_interval,next_reminder_at,created_at,assigned)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.companyId,
          input.code,
          userId,
          input.subjectEmployeeId ?? null,
          input.subjectKey,
          input.eventKey,
          input.title ?? template.name,
          input.message,
          template.importance,
          input.href ?? null,
          template.allowRepeat ? template.repeatInterval : "none",
          next,
          now,
          input.explicitSubjectOnly ?? false,
        ],
      )
    ).rows[0];
    if (created)
      await audit(
        client,
        null,
        "notification.create",
        "notification",
        created.id,
        null,
        {
          code: created.code,
          recipientUserId: userId,
          subjectKey: input.subjectKey,
          eventKey: input.eventKey,
          importance: created.importance,
        },
        input.companyId,
      );
  }
}
export async function refreshNotificationReminders(
  client: PoolClient,
  companyId: number | null,
) {
  const rows = (
    await client.query(
      notificationSelect +
        ` WHERE n.company_id IS NOT DISTINCT FROM $1::integer AND n.completed_at IS NULL
 AND ((n.next_reminder_at<=clock_timestamp() AND COALESCE(s.allow_repeat,false) AND COALESCE(s.enabled,t.implemented)) OR n.snoozed_until<=clock_timestamp())
 AND (n.snoozed_until IS NULL OR n.snoozed_until<=clock_timestamp()) ORDER BY n.id FOR UPDATE OF n`,
      [companyId],
    )
  ).rows;
  for (const row of rows) {
    const snoozeDue = !!row.snoozed_until,
      next =
        row.allow_repeat && row.template_enabled
          ? await nextReminder(client, row.repeat_interval)
          : null;
    await client.query(
      "UPDATE notifications SET read_at=NULL,snoozed_until=NULL,next_reminder_at=$1,reminder_count=reminder_count+1,last_reminded_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$2",
      [next, row.id],
    );
    await audit(
      client,
      null,
      "notification.remind",
      "notification",
      row.id,
      {
        reminderCount: row.reminder_count,
        snoozedUntil: row.snoozed_until?.toISOString() ?? null,
      },
      {
        reminderCount: row.reminder_count + 1,
        reason: snoozeDue ? "snooze-ended" : "scheduled-repeat",
      },
      companyId,
    );
  }
}
