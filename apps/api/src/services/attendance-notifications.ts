import type { Pool, PoolClient } from "pg";
import { transaction } from "../db.ts";
import { scanInventoryNotifications } from "./inventory-notifications.ts";
import {scanDueMemoSchedules} from "./memo-reminders.ts";
import {
  emitNotification,
  refreshNotificationReminders,
} from "./notifications.ts";
import { closeAttendanceRecord } from "./attendance-rewards.ts";

// These users are locked before the company, matching the request mutation order.
// Lock every possible follower, including the owner, before recipient FKs can be written.
const possibleRecipients = `SELECT u.id FROM users u WHERE
 (u.owner OR EXISTS(SELECT 1 FROM employees e WHERE e.company_id=$1 AND e.user_id=u.id)) ORDER BY u.id`;

async function pageEnabled(
  client: PoolClient,
  companyId: number | null,
  key: string,
) {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT COALESCE(bool_and(enabled),true) AS enabled FROM page_settings
     WHERE page_key=$2 AND (company_id IS NULL OR company_id=$1)`,
    [companyId, key],
  );
  return result.rows[0]!.enabled;
}

async function attendanceEvents(client: PoolClient, companyId: number) {
  const clock = (
    await client.query<{ now: Date; today: string; activatedAt: Date }>(
      `WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS now)
       SELECT moment.now,(moment.now AT TIME ZONE 'Asia/Aden')::date::text AS today,
       r.activated_at AS "activatedAt" FROM moment CROSS JOIN notification_runtime r WHERE r.singleton`,
    )
  ).rows[0];
  if (!clock) return;
  // Optional expected arrival is descriptive; it never gates a flexible punch.
  const lateRecords = (
    await client.query(
      `WITH actual AS (
         SELECT r.id,r.employee_id,r.employee_name,r.work_date::text AS work_date,r.checked_in_at,
           FLOOR(EXTRACT(EPOCH FROM r.checked_in_at-((r.work_date+r.expected_start_time) AT TIME ZONE 'Asia/Aden'))/60)::integer AS late_minutes
         FROM attendance_records r JOIN employees e ON e.company_id=r.company_id AND e.id=r.employee_id
         JOIN users u ON u.id=e.user_id
         WHERE r.company_id=$1 AND e.active AND NOT u.archived AND r.work_date BETWEEN $2::date-1 AND $2::date
         AND r.checked_in_at>=$3 AND r.checked_in_at<=$4 AND r.expected_start_time IS NOT NULL
         AND r.checked_in_at>((r.work_date+r.expected_start_time) AT TIME ZONE 'Asia/Aden')+interval '10 minutes'
         AND r.id=(SELECT first.id FROM attendance_records first WHERE first.company_id=r.company_id AND first.employee_id=r.employee_id AND first.work_date=r.work_date ORDER BY first.checked_in_at,first.id LIMIT 1)
       ) SELECT * FROM actual ORDER BY employee_id,work_date`,
      [companyId, clock.today, clock.activatedAt, clock.now],
    )
  ).rows;
  for (const row of lateRecords)
    await emitNotification(client, {
      code: "ATTENDANCE_LATE",
      companyId,
      subjectEmployeeId: row.employee_id,
      subjectKey: `employee:${row.employee_id}`,
      eventKey: `attendance:${row.id}:late`,
      message: `${row.employee_name}: الحضور بعد الوقت المتوقع بمقدار ${row.late_minutes} دقيقة، مع سماح عشر دقائق.`,
      href: `/companies/${companyId}/attendance?day=${row.work_date}`,
    });
}

/** Server-only producer. It never creates history before the notification module activation. */
export async function runAttendanceNotifications(pool: Pool): Promise<void> {
  const companyIds = (
    await pool.query<{ id: number }>("SELECT id FROM companies ORDER BY id")
  ).rows;
  const failures: unknown[] = [];
  for (const { id: companyId } of companyIds) {
    try {
      await transaction(pool, async (client) => {
        const lock = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':notification-worker'),$1::integer) AS acquired",
          [companyId],
        );
        if (!lock.rows[0]!.acquired) return;
        const users = await client.query<{ id: number }>(
          possibleRecipients + " FOR KEY SHARE OF u",
          [companyId],
        );
        const userIds = new Set(users.rows.map((user) => user.id));
        const company = await client.query(
          "SELECT id FROM companies WHERE id=$1 FOR UPDATE",
          [companyId],
        );
        if (!company.rowCount) return;
        // A new member may have been added while acquiring the company lock. Defer instead of
        // acquiring its user lock after the company and reversing the normal mutation lock order.
        const current = await client.query<{ id: number }>(possibleRecipients, [
          companyId,
        ]);
        if (current.rows.some((user) => !userIds.has(user.id))) return;
        // Auto-close protects the raw punch even when notification/attendance pages are disabled.
        const overdue = (
          await client.query(
            "SELECT id FROM attendance_records WHERE company_id=$1 AND checked_out_at IS NULL AND checked_in_at+(automatic_checkout_hours * interval '1 hour')<=clock_timestamp() ORDER BY id FOR UPDATE",
            [companyId],
          )
        ).rows;
        for (const record of overdue)
          await closeAttendanceRecord(client, {
            companyId,
            recordId: record.id,
            actorUser: null,
          });
        if (!(await pageEnabled(client, companyId, "company.notifications")))
          return;
        await scanDueMemoSchedules(client,companyId);
        await refreshNotificationReminders(client, companyId);
        if (await pageEnabled(client, companyId, "company.attendance"))
          await attendanceEvents(client, companyId);
        await scanInventoryNotifications(client, companyId);
      });
    } catch (error) {
      // One broken company must not delay notifications for every other company.
      failures.push(error);
    }
  }
  try {
    await transaction(pool, async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtext(current_schema()||':notification-worker'),0) AS acquired",
      );
      if (
        !lock.rows[0]!.acquired ||
        !(await pageEnabled(client, null, "public.notifications"))
      )
        return;
      await refreshNotificationReminders(client, null);
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw failures[0];
}

/** Runs immediately and every minute, serially; shutdown waits before the database pool closes. */
export function startAttendanceNotifications(pool: Pool): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = () => {
    if (stopped || running) return;
    running = runAttendanceNotifications(pool)
      .catch((error: unknown) => {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "worker_error";
        console.error(
          "Notification worker failed",
          /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "worker_error",
        );
      })
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
