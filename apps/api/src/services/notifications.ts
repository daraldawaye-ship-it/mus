import type { PoolClient, QueryResultRow } from "pg";
import type {
  NotificationRecord,
  NotificationTemplate,
} from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";
import { HttpError } from "../errors.ts";
import { memoFollowerSql } from "./memo-followers.ts";

export const memoNotificationCodes = ["MEMO_RECEIVED", "MEMO_REPLY", "MEMO_APPROVAL", "MEMO_COMPLETED", "MEMO_FOLLOW", "MEMO_DUE"];

export const pendingCashboxCodes = ["CASHBOX_ELECTRONIC_TRANSFER", "CASHBOX_POUCH_TRANSFER", "CASHBOX_CLOSED"];
const cashboxCodesSql = "('CASHBOX_ELECTRONIC_TRANSFER','CASHBOX_POUCH_TRANSFER','CASHBOX_CLOSED')";
export const latestStream = "CASE WHEN COALESCE(s.latest_only,t.default_latest_only) THEN n.stream_key ELSE '' END";
const currentNotification = `(NOT COALESCE(s.latest_only,t.default_latest_only) OR NOT EXISTS (
 SELECT 1 FROM notifications newer WHERE newer.recipient_user_id=n.recipient_user_id
 AND COALESCE(newer.company_id,0)=COALESCE(n.company_id,0) AND newer.code=n.code
 AND newer.stream_key=n.stream_key AND newer.id>n.id))`;
const selectedEmployee = `EXISTS(SELECT 1 FROM employees selected
 WHERE selected.company_id=n.company_id AND selected.id=$3 AND selected.user_id=$1 AND selected.active
 AND (selected.id=ANY(s.employee_ids) OR selected.position_keys && COALESCE(s.position_keys,t.default_position_keys)))`;

export const templateQuery = `SELECT t.*,s.id AS setting_id,s.revision,
 COALESCE(s.importance,t.default_importance) AS importance,COALESCE(s.enabled,t.implemented) AS enabled,
 COALESCE(s.can_snooze,true) AS can_snooze,COALESCE(s.allow_repeat,false) AS allow_repeat,
 COALESCE(s.repeat_interval,'none') AS repeat_interval,COALESCE(s.notify_managers,t.default_notify_managers) AS notify_managers,
 COALESCE(s.notify_subject,t.code NOT IN ('CASHBOX_ELECTRONIC_TRANSFER','CASHBOX_POUCH_TRANSFER','CASHBOX_CLOSED','ATTENDANCE_APPROVAL_REJECTED')) AS notify_subject,
 COALESCE(s.position_keys,t.default_position_keys) AS position_keys,s.min_interval_hours,COALESCE(s.latest_only,t.default_latest_only) AS latest_only,COALESCE(s.employee_ids,'{}'::integer[]) AS employee_ids
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
  positionKeys: r.position_keys,
  minIntervalHours: r.min_interval_hours,
  latestOnly: r.latest_only,
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
  if (companyId === 2 && code === 'INVENTORY_NEGATIVE') return r ? { ...templateDTO(r), enabled: false } : null;
  return r ? templateDTO(r) : null;
}
export const notificationSelect = `SELECT n.*,COALESCE(s.can_snooze,true) AS can_snooze,COALESCE(s.allow_repeat,false) AS allow_repeat,
 COALESCE(s.enabled,t.implemented) AS template_enabled,t.implemented,s.min_interval_hours,
 CASE WHEN NOT n.silent_update THEN n.created_at ELSE (SELECT origin.created_at FROM notifications origin WHERE origin.id=n.delivery_id) END AS delivery_at
 FROM notifications n JOIN notification_templates t ON t.code=n.code
 LEFT JOIN notification_settings s ON s.code=n.code AND s.company_id IS NOT DISTINCT FROM n.company_id`;
// Recipient identity is necessary but not sufficient: membership and current follow grants are checked again.
export const inboxFilter = `n.recipient_user_id=$1 AND NOT (n.company_id=2 AND n.code='INVENTORY_NEGATIVE') AND (
 (n.company_id IS NULL AND COALESCE((SELECT enabled FROM page_settings WHERE company_id IS NULL AND page_key='public.notifications'),true)) OR n.company_id=$2::integer)
 AND (n.company_id IS NULL OR $4::boolean OR n.assigned
 OR (COALESCE(s.notify_subject,true) AND n.subject_employee_id=$3::integer)
 OR (n.code IN ('SALES_DOCTOR_REVIEW','SALES_ARCHIVED_DOCTOR_USED') AND s.id IS NULL AND EXISTS(
       SELECT 1 FROM employees reviewer
       WHERE reviewer.company_id=n.company_id AND reviewer.user_id=$1
         AND reviewer.active AND reviewer.id=$3::integer
         AND 'sales-supervisor'=ANY(reviewer.position_keys)))
 OR ${selectedEmployee})
 AND ${currentNotification}
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
 AND (n.code NOT IN ('CHAT_GROUP_GLOBAL','CHAT_GROUP_COMPANY') OR EXISTS(
  SELECT 1 FROM chat_group_members gm
  JOIN chat_groups g ON g.id=gm.group_id
  JOIN chat_group_messages msg ON msg.group_id=gm.group_id
  WHERE gm.user_id=$1 AND gm.left_at IS NULL
   AND gm.group_id::text=split_part(n.subject_key,':',2)
   AND msg.id::text=split_part(n.subject_key,':',4)
   AND gm.joined_after_message_id<msg.id
   AND g.company_id IS NOT DISTINCT FROM n.company_id
 ))
 -- Inventory order-level messages follow the user's CURRENT position,
 -- even when a recipient was previously allowed to see an older notification.
 AND (n.code<>'ITEM_ORDER_LEVEL' OR EXISTS(
   SELECT 1 FROM users permitted
   LEFT JOIN employees sales_employee
     ON sales_employee.user_id=permitted.id
    AND sales_employee.company_id=n.company_id AND sales_employee.active
   WHERE permitted.id=$1 AND NOT permitted.archived
    AND (permitted.owner OR 'sales'=ANY(COALESCE(sales_employee.position_keys,'{}'::text[])))
 ))
 AND (n.code NOT IN ${cashboxCodesSql} OR ${selectedEmployee})`;
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
  silentUpdate: r.silent_update,
  deliveryId: r.silent_update ? r.delivery_id : r.id,
  deliveryAt: r.delivery_at?.toISOString() ?? null,
  revision: r.revision,
  subjectEmployeeId: r.subject_employee_id ?? null,
  groupCount: Number(r.group_count ?? 1),
  groupUnread: Number(r.group_unread ?? (r.read_at ? 0 : 1)),
  canSnooze: !r.completed_at && r.can_snooze,
  canRepeat:
    !r.completed_at && r.allow_repeat && r.template_enabled && r.implemented,
  canAssign: !r.completed_at && general && r.company_id !== null && !memoNotificationCodes.includes(r.code) && !pendingCashboxCodes.includes(r.code),
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
async function lockDelivery(client: PoolClient, companyId: number | null, code: string, userId: number) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()||':notification:'||$1),$2)",
    [String(companyId ?? 0) + ":" + code, userId]);
}

async function insideDeliveryWindow(client: PoolClient, companyId: number | null, code: string, userId: number, hours: number | null) {
  if (!hours) return false;
  const result = await client.query(
    `SELECT EXISTS (SELECT 1 FROM notifications
      WHERE COALESCE(company_id,0)=$1 AND code=$2 AND recipient_user_id=$3
        AND ((NOT silent_update AND created_at>clock_timestamp()-$4*interval '1 hour')
          OR last_reminded_at>clock_timestamp()-$4*interval '1 hour')) AS blocked`,
    [companyId ?? 0, code, userId, hours]);
  return result.rows[0].blocked as boolean;
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
    refreshOnly?: boolean;
    streamKey?: string;
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
  if (!template?.implemented || !template.enabled || (input.refreshOnly && !template.latestOnly)) return;
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
    recipients = ["SALES_DOCTOR_REVIEW", "SALES_ARCHIVED_DOCTOR_USED", "ATTENDANCE_APPROVAL_REJECTED"].includes(input.code) && template.revision === null
      ? (await client.query(
          `SELECT DISTINCT u.id FROM users u
             LEFT JOIN employees e ON e.user_id=u.id AND e.company_id=$1 AND e.active
             WHERE NOT u.archived AND NOT u.suspended AND (u.owner OR e.position_keys && $2::text[])
             ORDER BY u.id`,
          [input.companyId, template.positionKeys],
        )).rows.map((r) => r.id)
      : input.explicitSubjectOnly
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
   WHERE NOT u.archived AND NOT u.suspended AND (($2::boolean AND (u.owner OR e.is_general_manager)) OR ($3::boolean AND e.id=$4) OR e.id=ANY($5::integer[])
   OR e.position_keys && $6::text[]) ORDER BY u.id`,
        [
          input.companyId,
          template.notifyManagers && !pendingCashboxCodes.includes(input.code),
          template.notifySubject && !pendingCashboxCodes.includes(input.code),
          input.subjectEmployeeId ?? null,
          template.employeeIds,
          template.positionKeys,
        ],
      )
    ).rows.map((r) => r.id);
  } else {
    recipients = (
      await client.query(
        "SELECT id FROM users WHERE NOT archived AND (($1::boolean AND owner) OR ($2::boolean AND id=$3)) ORDER BY id",
        [
          !input.explicitSubjectOnly && template.notifyManagers,
          input.explicitSubjectOnly || template.notifySubject,
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
  const streamKey = input.streamKey ?? "";
  for (const userId of recipients) {
    if (template.latestOnly || template.minIntervalHours)
      await lockDelivery(client, input.companyId, input.code, userId);
    const blocked = !!input.refreshOnly || await insideDeliveryWindow(client, input.companyId, input.code, userId, template.minIntervalHours);
    if (blocked && !template.latestOnly) continue;
    let readAt: Date | null = null, snoozedUntil: Date | null = null;
    let deliveryId: number | null = null;
    if (template.latestOnly) {
      const scope = [input.companyId ?? 0, input.code, userId];
      const duplicate = await client.query(
        "SELECT 1 FROM notifications WHERE COALESCE(company_id,0)=$1 AND code=$2 AND recipient_user_id=$3 AND event_key=$4",
        [...scope, input.eventKey]);
      if (duplicate.rowCount) continue;
      const previous = (await client.query(
        `SELECT id,read_at,snoozed_until,completed_at,message,silent_update,delivery_id FROM notifications WHERE COALESCE(company_id,0)=$1
         AND code=$2 AND recipient_user_id=$3 AND stream_key=$4 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [...scope, streamKey])).rows[0];
      if (input.refreshOnly && (!previous || previous.completed_at)) continue;
      if (blocked) {
        if (pendingCashboxCodes.includes(input.code) && previous?.message === input.message && !previous.completed_at) continue;
        readAt = previous && !previous.completed_at ? previous.read_at : now;
        snoozedUntil = previous?.snoozed_until ?? null;
        if (previous && !previous.completed_at && !previous.read_at)
          deliveryId = previous.silent_update ? previous.delivery_id : previous.id;
      }
      // Free the active reason while keeping its immutable source and delivery history.
      await client.query(
        `UPDATE notifications SET completed_at=clock_timestamp(),read_at=COALESCE(read_at,clock_timestamp()),
         snoozed_until=NULL,next_reminder_at=NULL,revision=revision+1,updated_at=clock_timestamp()
         WHERE COALESCE(company_id,0)=$1 AND code=$2 AND recipient_user_id=$3 AND stream_key=$4 AND completed_at IS NULL`,
        [...scope, streamKey]);
    }
    const created = (
      await client.query(
        `INSERT INTO notifications(company_id,code,recipient_user_id,subject_employee_id,subject_key,event_key,title,message,importance,href,repeat_interval,next_reminder_at,created_at,assigned,stream_key,silent_update,read_at,snoozed_until,delivery_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp(),$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING RETURNING *`,
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
          input.explicitSubjectOnly ?? false,
          streamKey, blocked, readAt, snoozedUntil, deliveryId,
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
        ` WHERE n.company_id IS NOT DISTINCT FROM $1::integer AND NOT (n.company_id=2 AND n.code='INVENTORY_NEGATIVE') AND n.completed_at IS NULL
 AND ${currentNotification} AND ((n.next_reminder_at<=clock_timestamp() AND COALESCE(s.allow_repeat,false) AND COALESCE(s.enabled,t.implemented)) OR n.snoozed_until<=clock_timestamp())
 AND (n.snoozed_until IS NULL OR n.snoozed_until<=clock_timestamp()) ORDER BY n.id FOR UPDATE OF n`,
      [companyId],
    )
  ).rows;
  for (const row of rows) {
    if (row.min_interval_hours) {
      const locked = await client.query(
        "SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':notification:'||$1),$2) AS ok",
        [String(companyId ?? 0)+":"+row.code,row.recipient_user_id]);
      if (!locked.rows[0].ok) continue;
      if (await insideDeliveryWindow(client, companyId, row.code, row.recipient_user_id, row.min_interval_hours)) continue;
    }
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
