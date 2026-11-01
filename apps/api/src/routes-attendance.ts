import { Router, type Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  attendanceCheckInSchema,
  attendanceCheckOutSchema,
  type AttendanceRecord,
  type AttendanceSchedule,
  type AttendanceReportRow,
  type AttendanceDailySummary,
} from "../../../packages/contracts/src/index.ts";
import { documentDateSchema } from "../../../packages/contracts/src/finance.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { HttpError, missing, deny } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { assertRequestPagesEnabled, directoryEntries, assertDirectoryAccess } from "./services/pages.ts";
import { permissionRuleEffects } from "./services/permission-rules.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { getAttendanceSettings } from "./services/attendance-settings.ts";
import { attendanceAutoHours } from "./services/control-values.ts";
import {
  awardAttendanceCheckIn,
  closeAttendanceRecord,
} from "./services/attendance-rewards.ts";

const records = `SELECT r.*,r.work_date::text AS work_date,r.start_time::text AS start_time,r.end_time::text AS end_time,
 r.hourly_points::text AS hourly_points,r.default_daily_hours::text AS default_daily_hours,r.expected_start_time::text AS expected_start_time,
 COALESCE(points.paid_microseconds,0)::text AS paid_microseconds,COALESCE(points.awarded_points,0)::text AS awarded_points
 FROM attendance_records r LEFT JOIN LATERAL (
 SELECT sum(eligible_microseconds) FILTER(WHERE kind='worked') AS paid_microseconds,sum(points) AS awarded_points
 FROM attendance_point_entries WHERE company_id=r.company_id AND attendance_record_id=r.id
 ) points ON true`;
const schedules = `SELECT s.*,s.start_time::text AS start_time,s.end_time::text AS end_time,b.name AS branch_name FROM employee_schedules s
 JOIN branches b ON b.company_id=s.company_id AND b.id=s.branch_id`;
const seconds = (microseconds: unknown) =>
  (BigInt(String(microseconds ?? "0")) / 1000000n).toString();
const recordDTO = (row: QueryResultRow): AttendanceRecord => ({
  id: row.id,
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  branchName: row.branch_name ?? null,
  workDate: row.work_date,
  checkedInAt: row.checked_in_at.toISOString(),
  checkedOutAt: row.checked_out_at?.toISOString() ?? null,
  startTime: row.start_time?.slice(0, 5) ?? null,
  endTime: row.end_time?.slice(0, 5) ?? null,
  revision: row.revision,
  hourlyPoints:
    row.hourly_points === null || row.hourly_points === undefined
      ? null
      : String(row.hourly_points),
  defaultDailyHours:
    row.default_daily_hours === null || row.default_daily_hours === undefined
      ? null
      : String(row.default_daily_hours),
  expectedStartTime: row.expected_start_time?.slice(0, 5) ?? null,
  allowOvertime: row.allow_overtime ?? false,
  settingsRevision: row.settings_revision ?? null,
  paidSeconds: seconds(row.paid_microseconds),
  points: String(row.awarded_points ?? "0"),
  closeSource: row.close_source ?? (row.checked_out_at ? "manual" : null),
  needsReview: row.needs_review ?? false,
});
const scheduleDTO = (row: QueryResultRow): AttendanceSchedule => ({
  employeeId: row.employee_id,
  branchId: row.branch_id,
  branchName: row.branch_name,
  workDays: row.work_days,
  startTime: row.start_time.slice(0, 5),
  endTime: row.end_time.slice(0, 5),
  active: row.active,
  revision: row.revision,
});
async function access(client: PoolClient, req: Request, write = false) {
  const companyId = id(req.params.companyId),
    user = await currentActor(client, actor(req), write);
  const context = await companyAccess(
    client,
    user,
    companyId,
    undefined,
    write,
  );
  if (write) await assertRequestPagesEnabled(client, req, true);
  return { companyId, user, context };
}
async function clock(client: PoolClient) {
  return (
    await client.query(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS instant)
 SELECT instant,(instant AT TIME ZONE 'Asia/Aden')::date::text AS today FROM moment`)
  ).rows[0]!;
}
async function dailySummary(
  client: PoolClient,
  companyId: number,
  employeeId: number | null,
  day: string,
): Promise<AttendanceDailySummary> {
  const row = (
    await client.query(
      `WITH sessions AS (
  SELECT count(*)::integer AS session_count,count(*) FILTER(WHERE needs_review)::integer AS review_count,
   COALESCE(FLOOR(sum(EXTRACT(EPOCH FROM checked_out_at-checked_in_at)) FILTER(WHERE checked_out_at IS NOT NULL)),0)::text AS closed_seconds
  FROM attendance_records WHERE company_id=$1 AND employee_id=$2 AND work_date=$3::date
 ),earnings AS (
  SELECT COALESCE(sum(eligible_microseconds) FILTER(WHERE kind='worked'),0)::text AS paid_microseconds,COALESCE(sum(points),0)::text AS points
  FROM attendance_point_entries WHERE company_id=$1 AND employee_id=$2 AND work_date=$3::date
 ) SELECT sessions.*,earnings.*,policy.default_daily_hours::text AS daily_hours,policy.allow_overtime
 FROM sessions CROSS JOIN earnings LEFT JOIN attendance_day_policies policy ON policy.company_id=$1 AND policy.employee_id=$2 AND policy.work_date=$3::date`,
      [companyId, employeeId, day],
    )
  ).rows[0];
  return {
    closedSeconds: row.closed_seconds,
    paidSeconds: seconds(row.paid_microseconds),
    points: row.points,
    sessionCount: row.session_count,
    reviewCount: row.review_count,
    defaultDailyHours: row.daily_hours ?? null,
    allowOvertime: row.allow_overtime ?? null,
  };
}
export function attendanceRoutes(pool: Pool) {
  const router = Router(),
    base = "/companies/:companyId/attendance";
  // Latest presence is NOT restricted to the current day: employees who are
  // absent now still have their actual last arrival and departure displayed.
  // Every active company member with this specific page permission may view
  // the report. Explicit page denials remain enforced server-side.
  router.get(base + "/currently-present", handler(async (req, res) => {
    const result = await transaction(pool, async client => {
      await client.query("SET TRANSACTION READ ONLY");
      const { companyId, user } = await access(client, req);
      const entry = (await directoryEntries(client, user, companyId))
        .find(page => page.key === "company.attendance-current");
      if (!entry) deny("الصفحة غير مسجلة في دليل الصفحات");
      assertDirectoryAccess(entry);
      const rows = await client.query(`
        SELECT e.id,e.name,
          active.checked_in_at AS open_checked_in_at,
          arrived.checked_in_at AS last_checked_in_at,
          departed.checked_out_at AS last_checked_out_at
        FROM employees e
        LEFT JOIN LATERAL (
          SELECT r.checked_in_at FROM attendance_records r
          WHERE r.company_id=e.company_id AND r.employee_id=e.id AND r.checked_out_at IS NULL
          ORDER BY r.checked_in_at DESC,r.id DESC LIMIT 1
        ) active ON true
        LEFT JOIN LATERAL (
          SELECT r.checked_in_at FROM attendance_records r
          WHERE r.company_id=e.company_id AND r.employee_id=e.id
          ORDER BY r.checked_in_at DESC,r.id DESC LIMIT 1
        ) arrived ON true
        LEFT JOIN LATERAL (
          SELECT r.checked_out_at FROM attendance_records r
          WHERE r.company_id=e.company_id AND r.employee_id=e.id AND r.checked_out_at IS NOT NULL
          ORDER BY r.checked_out_at DESC,r.id DESC LIMIT 1
        ) departed ON true
        WHERE e.company_id=$1 AND e.active
        ORDER BY (active.checked_in_at IS NOT NULL) DESC,
          active.checked_in_at DESC NULLS LAST,
          arrived.checked_in_at DESC NULLS LAST,e.id
        LIMIT 1000`, [companyId]);
      return { items: rows.rows.map(row => ({
        employeeId: row.id,
        employeeName: row.name,
        isPresent: !!row.open_checked_in_at,
        lastCheckedInAt: row.last_checked_in_at?.toISOString() ?? null,
        lastCheckedOutAt: row.last_checked_out_at?.toISOString() ?? null,
      })) };
    });
    res.json(result);
  }));
  router.get(
    base,
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, context } = await access(client, req),
          ownId = context.employee?.id ?? null;
        const employeeId =
          req.query.employeeId === undefined
            ? null
            : id(
                typeof req.query.employeeId === "string"
                  ? req.query.employeeId
                  : undefined,
              );
        if (!context.general && employeeId !== null && employeeId !== ownId)
          deny("يمكنك عرض سجل حضورك فقط");
        if (
          employeeId !== null &&
          !(
            await client.query(
              "SELECT 1 FROM employees WHERE company_id=$1 AND id=$2",
              [companyId, employeeId],
            )
          ).rowCount
        )
          missing();
        const time = await clock(client),
          day =
            req.query.day === undefined
              ? time.today
              : parse(documentDateSchema, req.query.day);
        const employees = (
          await client.query(
            "SELECT id,name FROM employees WHERE company_id=$1 AND active AND ($2::boolean OR id=$3) ORDER BY name,id",
            [companyId, context.general, ownId],
          )
        ).rows;
        const definitions = (
          await client.query(
            schedules +
              " WHERE s.company_id=$1 AND ($2::boolean OR s.employee_id=$3) ORDER BY s.employee_id",
            [companyId, context.general, ownId],
          )
        ).rows.map(scheduleDTO);
        const open = ownId
          ? (
              await client.query(
                records +
                  " WHERE r.company_id=$1 AND r.employee_id=$2 AND r.checked_out_at IS NULL",
                [companyId, ownId],
              )
            ).rows[0]
          : null;
        const today = ownId
          ? (
              await client.query(
                records +
                  " WHERE r.company_id=$1 AND r.employee_id=$2 AND r.work_date=$3::date ORDER BY r.checked_in_at DESC,r.id DESC LIMIT 1",
                [companyId, ownId, time.today],
              )
            ).rows[0]
          : null;
        const effects =
          context.general || !ownId
            ? new Map()
            : await permissionRuleEffects(client, companyId, ownId);
        const punch =
          !!ownId && effects.get("company.attendance:create") !== "deny";
        const query = listQuery(
          req.query,
          {
            id: "r.id",
            workDate: "r.work_date",
            employeeName: "r.employee_name",
            checkedInAt: "r.checked_in_at",
            checkedOutAt: "r.checked_out_at",
          },
          "workDate:desc,id:desc",
        );
        const args: unknown[] = [companyId, day, searchPattern(query.q)],
          target = context.general ? employeeId : ownId;
        let filter =
          "r.company_id=$1 AND r.work_date=$2::date AND r.employee_name ILIKE $3";
        if (target !== null) {
          args.push(target);
          filter += ` AND r.employee_id=$${args.length}`;
        }
        const total = (
          await client.query(
            `SELECT count(*)::integer AS total FROM attendance_records r WHERE ${filter}`,
            args,
          )
        ).rows[0].total;
        const list = (
          await client.query(
            `${records} WHERE ${filter} ORDER BY ${query.order} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
            [...args, query.pageSize, query.offset],
          )
        ).rows;
        return {
          items: list.map(recordDTO),
          total,
          page: query.page,
          pageSize: query.pageSize,
          today: time.today,
          workDate: time.today,
          openRecord: open ? recordDTO(open) : null,
          todayRecord: today ? recordDTO(today) : null,
          selfEmployeeId: ownId,
          canCheckIn: punch && !open,
          canCheckOut: punch && !!open,
          ownSettings: ownId
            ? await getAttendanceSettings(client, companyId, ownId)
            : null,
          dailySummary: await dailySummary(client, companyId, ownId, day),
          schedules: definitions,
          employees,
          branches: [],
        };
      });
      res.json(result);
    }),
  );
  router.get(
    base + "/report",
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, context } = await access(client, req),
          ownId = context.employee?.id ?? null,
          time = await clock(client);
        const day =
          req.query.day === undefined
            ? time.today
            : parse(documentDateSchema, req.query.day);
        const employeeId =
          req.query.employeeId === undefined
            ? null
            : id(
                typeof req.query.employeeId === "string"
                  ? req.query.employeeId
                  : undefined,
              );
        if (!context.general && employeeId !== null && employeeId !== ownId)
          deny("يمكنك عرض تقرير حضورك فقط");
        if (
          employeeId !== null &&
          !(
            await client.query(
              "SELECT 1 FROM employees WHERE company_id=$1 AND id=$2",
              [companyId, employeeId],
            )
          ).rowCount
        )
          missing();
        const status = req.query.status ?? "";
        if (
          typeof status !== "string" ||
          ![
            "",
            "present",
            "open",
            "missingCheckout",
            "absent",
            "waiting",
            "notRecorded",
            "rest",
            "unconfigured",
            "late",
          ].includes(status)
        )
          throw new HttpError(400, "invalid_query", "حالة الحضور غير صالحة");
        const query = listQuery(
          req.query,
          {
            id: "f.employee_id",
            employeeName: "f.employee_name",
            workDate: "f.work_date",
            checkedInAt: "f.checked_in_at",
            checkedOutAt: "f.checked_out_at",
            status: "f.status",
            lateMinutes: "f.late_minutes",
            workedMinutes: "f.worked_minutes",
            earlyLeaveMinutes: "f.early_leave_minutes",
          },
          "employeeName:asc",
        );
        const args = [
          companyId,
          day,
          context.general ? employeeId : ownId,
          searchPattern(query.q),
          status,
        ];
        const sql = `WITH session_totals AS (
    SELECT employee_id,count(*)::integer AS session_count,count(*) FILTER(WHERE needs_review)::integer AS review_count,
      min(checked_in_at) AS checked_in_at,max(checked_out_at) AS checked_out_at,bool_or(checked_out_at IS NULL) AS has_open,
      COALESCE(FLOOR(sum(EXTRACT(EPOCH FROM checked_out_at-checked_in_at)) FILTER(WHERE checked_out_at IS NOT NULL)),0)::bigint AS closed_seconds
    FROM attendance_records WHERE company_id=$1 AND work_date=$2::date GROUP BY employee_id
   ),earnings AS (
    SELECT employee_id,COALESCE(sum(eligible_microseconds) FILTER(WHERE kind='worked'),0) AS paid_microseconds,COALESCE(sum(points),0) AS points
    FROM attendance_point_entries WHERE company_id=$1 AND work_date=$2::date GROUP BY employee_id
   ),computed AS (
    SELECT e.id AS employee_id,e.name AS employee_name,$2::date AS work_date,first_record.branch_name,
      sessions.checked_in_at,CASE WHEN sessions.has_open THEN NULL ELSE sessions.checked_out_at END AS checked_out_at,
      COALESCE(first_record.expected_start_time,first_record.start_time) AS start_time,NULL::time AS end_time,
      COALESCE(sessions.session_count,0) AS session_count,COALESCE(sessions.review_count,0) AS review_count,
      COALESCE(sessions.closed_seconds,0) AS closed_seconds,COALESCE(earnings.paid_microseconds,0) AS paid_microseconds,COALESCE(earnings.points,0) AS points,
      CASE WHEN sessions.has_open THEN 'open' WHEN sessions.review_count>0 THEN 'missingCheckout' WHEN sessions.session_count>0 THEN 'present' ELSE 'notRecorded' END AS status,
      COALESCE(sessions.checked_in_at>(($2::date+first_record.expected_start_time) AT TIME ZONE 'Asia/Aden')+interval '10 minutes',false) AS is_late,
      CASE WHEN first_record.expected_start_time IS NULL OR sessions.checked_in_at<=(($2::date+first_record.expected_start_time) AT TIME ZONE 'Asia/Aden')+interval '10 minutes' THEN 0 ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM sessions.checked_in_at-(($2::date+first_record.expected_start_time) AT TIME ZONE 'Asia/Aden'))/60))::integer END AS late_minutes,
      CASE WHEN sessions.session_count IS NULL THEN NULL ELSE FLOOR(sessions.closed_seconds/60)::integer END AS worked_minutes,NULL::integer AS early_leave_minutes
    FROM employees e LEFT JOIN session_totals sessions ON sessions.employee_id=e.id LEFT JOIN earnings ON earnings.employee_id=e.id
    LEFT JOIN LATERAL(SELECT r.branch_name,r.expected_start_time,r.start_time FROM attendance_records r
     WHERE r.company_id=e.company_id AND r.employee_id=e.id AND r.work_date=$2::date ORDER BY r.checked_in_at,r.id LIMIT 1) first_record ON true
    WHERE e.company_id=$1 AND ($3::integer IS NULL OR e.id=$3) AND (e.active OR sessions.session_count>0 OR earnings.employee_id IS NOT NULL)
   ),filtered AS(SELECT * FROM computed WHERE employee_name ILIKE $4 AND ($5='' OR status=$5 OR ($5='late' AND is_late))) `;
        const summary = (
          await client.query(
            sql +
              `SELECT count(*)::integer AS total,count(*) FILTER(WHERE session_count>0)::integer AS attended,
    0::integer AS absent,count(*) FILTER(WHERE is_late)::integer AS late,count(*) FILTER(WHERE review_count>0)::integer AS "missingCheckout",
    COALESCE(sum(worked_minutes),0)::double precision AS "workedMinutes",COALESCE(sum(closed_seconds),0)::text AS "closedSeconds",
    COALESCE(sum(paid_microseconds),0)::text AS paid_microseconds,COALESCE(sum(points),0)::text AS points,
    COALESCE(sum(session_count),0)::integer AS "sessionCount",COALESCE(sum(review_count),0)::integer AS "reviewCount" FROM filtered`,
            args,
          )
        ).rows[0];
        const rows = (
          await client.query(
            sql +
              `SELECT *,work_date::text AS work_date,start_time::text AS start_time,end_time::text AS end_time,
    closed_seconds::text AS closed_seconds,paid_microseconds::text AS paid_microseconds,points::text AS points
    FROM filtered f ORDER BY ${query.order} LIMIT $6 OFFSET $7`,
            [...args, query.pageSize, query.offset],
          )
        ).rows;
        const items: AttendanceReportRow[] = rows.map((row) => ({
          id: row.employee_id,
          employeeId: row.employee_id,
          employeeName: row.employee_name,
          branchName: row.branch_name ?? null,
          workDate: row.work_date,
          checkedInAt: row.checked_in_at?.toISOString() ?? null,
          checkedOutAt: row.checked_out_at?.toISOString() ?? null,
          startTime: row.start_time?.slice(0, 5) ?? null,
          endTime: null,
          status: row.status,
          lateMinutes: row.late_minutes,
          workedMinutes: row.worked_minutes,
          earlyLeaveMinutes: null,
          closedSeconds: row.closed_seconds,
          paidSeconds: seconds(row.paid_microseconds),
          points: row.points,
          sessionCount: row.session_count,
          reviewCount: row.review_count,
        }));
        const { paid_microseconds, ...rest } = summary;
        return {
          items,
          total: summary.total,
          page: query.page,
          pageSize: query.pageSize,
          day,
          summary: { ...rest, paidSeconds: seconds(paid_microseconds) },
        };
      });
      res.json(result);
    }),
  );
  router.put(
    base + "/schedules/:employeeId",
    handler(async (req, _res) => {
      await transaction(pool, async (client) => {
        const { context } = await access(client, req);
        if (!context.general)
          deny("إدارة إعدادات الحضور للمدير العام أو المالك");
      });
      throw new HttpError(
        400,
        "settings_moved",
        "انتقلت إعدادات الحضور إلى كرت الموظف؛ لا توجد وردية ثابتة أو أيام تمنع التسجيل",
      );
    }),
  );
  router.post(
    base + "/check-in",
    handler(async (req, res) => {
      const input = parse(attendanceCheckInSchema, req.body);
      const record = await transaction(pool, async (client) => {
        const { companyId, user, context } = await access(client, req, true),
          employee = context.employee;
        if (!employee) deny("يلزم ربط حسابك بموظف فعال لتسجيل حضورك");
        const previous = (
          await client.query(
            records +
              " WHERE r.company_id=$1 AND r.employee_id=$2 AND r.idempotency_key=$3",
            [companyId, employee.id, input.idempotencyKey],
          )
        ).rows[0];
        if (previous) return recordDTO(previous);
        const time = await clock(client);
        const open = (
          await client.query(
            records +
              " WHERE r.company_id=$1 AND r.employee_id=$2 AND r.checked_out_at IS NULL",
            [companyId, employee.id],
          )
        ).rows[0];
        if (open) {
          const expired = (
            await client.query(
              "SELECT $1::timestamptz>=checked_in_at+(automatic_checkout_hours * interval '1 hour') AS expired FROM attendance_records WHERE company_id=$2 AND id=$3",
              [time.instant, companyId, open.id],
            )
          ).rows[0]?.expired;
          if (!expired) return recordDTO(open);
          await closeAttendanceRecord(client, {
            companyId,
            recordId: open.id,
            actorUser: null,
            now: time.instant,
          });
        }
        const settings = await getAttendanceSettings(
          client,
          companyId,
          employee.id,
        );
        if (settings.defaultDailyHours !== null)
          await client.query(
            "INSERT INTO attendance_day_policies(company_id,employee_id,work_date,default_daily_hours,allow_overtime) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [
              companyId,
              employee.id,
              time.today,
              settings.defaultDailyHours,
              settings.allowOvertime,
            ],
          );
        const inserted = (
          await client.query(
            `INSERT INTO attendance_records(company_id,employee_id,employee_name,work_date,checked_in_at,idempotency_key,created_by,updated_by,
    hourly_points,default_daily_hours,expected_start_time,allow_overtime,settings_revision,automatic_checkout_hours) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
            [
              companyId,
              employee.id,
              employee.name,
              time.today,
              time.instant,
              input.idempotencyKey,
              user.id,
              settings.hourlyPoints,
              settings.defaultDailyHours,
              settings.expectedStartTime,
              settings.allowOvertime,
              settings.revision,
              await attendanceAutoHours(client, companyId),
            ],
          )
        ).rows[0];
        await awardAttendanceCheckIn(client, companyId, inserted.id, user);
        const after = recordDTO(
          (
            await client.query(records + " WHERE r.company_id=$1 AND r.id=$2", [
              companyId,
              inserted.id,
            ])
          ).rows[0],
        );
        await audit(
          client,
          user,
          "attendance.checkIn",
          "attendance",
          after.id,
          null,
          after,
          companyId,
        );
        return after;
      });
      res.json({ record });
    }),
  );
  router.post(
    base + "/check-out",
    handler(async (req, res) => {
      const input = parse(attendanceCheckOutSchema, req.body);
      const record = await transaction(pool, async (client) => {
        const { companyId, user, context } = await access(client, req, true),
          employee = context.employee;
        if (!employee) deny("يلزم ربط حسابك بموظف فعال");
        const row = (
          await client.query(
            records +
              " WHERE r.company_id=$1 AND r.employee_id=$2 AND r.id=$3 FOR UPDATE OF r",
            [companyId, employee.id, input.recordId],
          )
        ).rows[0];
        if (!row) missing();
        if (row.checked_out_at) return recordDTO(row);
        return recordDTO(
          await closeAttendanceRecord(client, {
            companyId,
            recordId: input.recordId,
            actorUser: user,
          }),
        );
      });
      res.json({ record });
    }),
  );
  return router;
}
