import type { Pool, PoolClient, QueryResultRow } from "pg";
import { transaction } from "../db.ts";
import { scanInventoryNotifications } from "./inventory-notifications.ts";
import {
  emitNotification,
  refreshNotificationReminders,
} from "./notifications.ts";

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
  const href = (day: string) => `/companies/${companyId}/attendance?day=${day}`;
  const emit = async (code: string, row: QueryResultRow, message: string) =>
    emitNotification(client, {
      code,
      companyId,
      subjectEmployeeId: row.employee_id,
      subjectKey: `employee:${row.employee_id}`,
      eventKey: `${code}:${row.employee_id}:${row.work_date}`,
      message,
      href: href(row.work_date),
    });

  // Presence has its own immutable schedule snapshot; later schedule edits cannot change lateness.
  const lateRecords = (
    await client.query(
      `WITH actual AS (
         SELECT r.employee_id,r.employee_name,r.work_date::text AS work_date,r.checked_in_at,
           FLOOR(EXTRACT(EPOCH FROM r.checked_in_at-((r.work_date+r.start_time) AT TIME ZONE 'Asia/Aden'))/60)::integer AS late_minutes
         FROM attendance_records r JOIN employees e ON e.company_id=r.company_id AND e.id=r.employee_id
         JOIN users u ON u.id=e.user_id
         WHERE r.company_id=$1 AND e.active AND NOT u.archived AND r.work_date BETWEEN $2::date-1 AND $2::date
         AND r.checked_in_at>=$3 AND r.checked_in_at<=$4
       ) SELECT * FROM actual WHERE late_minutes>0 ORDER BY employee_id,work_date`,
      [companyId, clock.today, clock.activatedAt, clock.now],
    )
  ).rows;
  for (const row of lateRecords)
    await emit(
      "ATTENDANCE_LATE",
      row,
      `${row.employee_name}: تأخر عن بداية دوام ${row.work_date} بمقدار ${row.late_minutes} دقيقة.`,
    );

  // Scan only today and yesterday. Yesterday is required for a shift ending after midnight.
  // Unknown historical schedules and rest days never become inferred absence.
  const missingRecords = (
    await client.query(
      `WITH expected AS (
         SELECT e.id AS employee_id,e.name AS employee_name,d.work_date,h.start_time,h.end_time
         FROM employees e JOIN users u ON u.id=e.user_id
         CROSS JOIN (VALUES($2::date),($2::date-1)) d(work_date)
         JOIN LATERAL(SELECT sh.* FROM employee_schedule_history sh
           WHERE sh.company_id=e.company_id AND sh.employee_id=e.id AND sh.effective_date<=d.work_date
           ORDER BY sh.effective_date DESC,sh.revision DESC LIMIT 1) h ON true
         WHERE e.company_id=$1 AND e.active AND NOT u.archived AND h.active
         AND EXTRACT(DOW FROM d.work_date)::smallint=ANY(h.work_days)
         AND NOT EXISTS(SELECT 1 FROM attendance_records r WHERE r.company_id=e.company_id AND r.employee_id=e.id AND r.work_date=d.work_date)
       ),timed AS (
         SELECT *, (work_date+start_time) AT TIME ZONE 'Asia/Aden' AS scheduled_start,
          (work_date+end_time+CASE WHEN end_time<start_time THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE 'Asia/Aden' AS scheduled_end
         FROM expected
       ) SELECT *,work_date::text AS work_date,
          scheduled_start+interval '30 minutes'>=$3 AND $4>=scheduled_start+interval '30 minutes' AND $4<scheduled_end AS missed,
          scheduled_end>=$3 AND $4>=scheduled_end AS absent
         FROM timed WHERE (scheduled_start+interval '30 minutes'>=$3 AND $4>=scheduled_start+interval '30 minutes' AND $4<scheduled_end)
            OR (scheduled_end>=$3 AND $4>=scheduled_end)
         ORDER BY timed.employee_id,timed.work_date`,
      [companyId, clock.today, clock.activatedAt, clock.now],
    )
  ).rows;
  for (const row of missingRecords) {
    if (row.missed)
      await emit(
        "ATTENDANCE_MISSED_30",
        row,
        `${row.employee_name}: لم يسجل الحضور بعد مرور 30 دقيقة على بداية دوام ${row.work_date}.`,
      );
    if (row.absent)
      await emit(
        "ATTENDANCE_ABSENT",
        row,
        `${row.employee_name}: انتهى دوام ${row.work_date} دون تسجيل حضور.`,
      );
  }

  // An open punch can outlive a calendar day; scan all open records, without backfilling old thresholds.
  const openRecords = (
    await client.query(
      `SELECT r.employee_id,r.employee_name,r.work_date::text AS work_date
       FROM attendance_records r JOIN employees e ON e.company_id=r.company_id AND e.id=r.employee_id
       JOIN users u ON u.id=e.user_id WHERE r.company_id=$1 AND e.active AND NOT u.archived
       AND r.checked_out_at IS NULL AND r.checked_in_at+interval '16 hours'>=$2 AND r.checked_in_at+interval '16 hours'<=$3
       ORDER BY r.employee_id,r.id`,
      [companyId, clock.activatedAt, clock.now],
    )
  ).rows;
  for (const row of openRecords)
    await emit(
      "ATTENDANCE_OPEN_16H",
      row,
      `${row.employee_name}: تجاوز الحضور المسجل ليوم ${row.work_date} مدة 16 ساعة دون تسجيل انصراف.`,
    );
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
        if (!(await pageEnabled(client, companyId, "company.notifications")))
          return;
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
