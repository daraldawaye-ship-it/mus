import { Router, type Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  attendanceScheduleSchema,
  attendanceCheckInSchema,
  attendanceCheckOutSchema,
  type AttendanceRecord,
  type AttendanceSchedule,
  type AttendanceReportRow,
} from "../../../packages/contracts/src/index.ts";
import { documentDateSchema } from "../../../packages/contracts/src/finance.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import {
  companyAccess,
  currentActor,
  manageEmployees,
} from "./policies/access.ts";
import { HttpError, missing, deny } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { permissionRuleEffects } from "./services/permission-rules.ts";
import { listQuery, searchPattern } from "./services/lists.ts";

const records = `SELECT r.*,r.work_date::text AS work_date,r.start_time::text AS start_time,r.end_time::text AS end_time FROM attendance_records r`;
const schedules = `SELECT s.*,s.start_time::text AS start_time,s.end_time::text AS end_time,b.name AS branch_name,b.active AS branch_active FROM employee_schedules s JOIN branches b ON b.company_id=s.company_id AND b.id=s.branch_id`;
const recordDTO = (row: QueryResultRow): AttendanceRecord => ({
  id: row.id,
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  branchName: row.branch_name,
  workDate: row.work_date,
  checkedInAt: row.checked_in_at.toISOString(),
  checkedOutAt: row.checked_out_at?.toISOString() ?? null,
  startTime: row.start_time.slice(0, 5),
  endTime: row.end_time.slice(0, 5),
  revision: row.revision,
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
async function clock(client: PoolClient, schedule: AttendanceSchedule | null) {
  const result = await client.query(
    `WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS instant),day AS(
 SELECT instant,(instant AT TIME ZONE 'Asia/Aden')::date AS today,
 CASE WHEN $1::time>$2::time AND (instant AT TIME ZONE 'Asia/Aden')::time<$2::time
 THEN (instant AT TIME ZONE 'Asia/Aden')::date-1 ELSE (instant AT TIME ZONE 'Asia/Aden')::date END AS work_date FROM moment)
 SELECT instant,today::text,work_date::text,EXTRACT(DOW FROM work_date)::integer AS weekday FROM day`,
    [schedule?.startTime ?? "00:00", schedule?.endTime ?? "23:59"],
  );
  return result.rows[0]!;
}
export function attendanceRoutes(pool: Pool) {
  const router = Router(),
    base = "/companies/:companyId/attendance";
  router.get(
    base,
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, context } = await access(client, req);
        const ownId = context.employee?.id ?? null;
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
        const employees = await client.query(
          "SELECT id,name FROM employees WHERE company_id=$1 AND active AND ($2::boolean OR id=$3) ORDER BY name,id",
          [companyId, context.general, ownId],
        );
        const found = await client.query(
          schedules +
            " WHERE s.company_id=$1 AND ($2::boolean OR s.employee_id=$3) ORDER BY s.employee_id",
          [companyId, context.general, ownId],
        );
        const definitions = found.rows.map(scheduleDTO),
          own = definitions.find((s) => s.employeeId === ownId) ?? null;
        const time = await clock(client, own);
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
                  " WHERE r.company_id=$1 AND r.employee_id=$2 AND r.work_date=$3",
                [companyId, ownId, time.work_date],
              )
            ).rows[0]
          : null;
        const effects =
          context.general || !ownId
            ? new Map()
            : await permissionRuleEffects(client, companyId, ownId);
        const punch =
          !!ownId && effects.get("company.attendance:create") !== "deny";
        const ownRow = found.rows.find((s) => s.employee_id === ownId);
        const columns = {
          id: "r.id",
          workDate: "r.work_date",
          employeeName: "r.employee_name",
          checkedInAt: "r.checked_in_at",
          checkedOutAt: "r.checked_out_at",
        };
        const query = listQuery(req.query, columns, "workDate:desc,id:desc");
        const day =
          req.query.day === undefined
            ? time.work_date
            : parse(documentDateSchema, req.query.day);
        const args: unknown[] = [companyId, day, searchPattern(query.q)];
        let filter =
          "r.company_id=$1 AND r.work_date=$2 AND r.employee_name ILIKE $3";
        const target = context.general ? employeeId : ownId;
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
        const list = await client.query(
          `${records} WHERE ${filter} ORDER BY ${query.order} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, query.pageSize, query.offset],
        );
        const branches = context.general
          ? (
              await client.query(
                "SELECT id,name FROM branches WHERE company_id=$1 AND active ORDER BY code,id",
                [companyId],
              )
            ).rows
          : [];
        return {
          items: list.rows.map(recordDTO),
          total,
          page: query.page,
          pageSize: query.pageSize,
          today: time.today,
          workDate: time.work_date,
          openRecord: open ? recordDTO(open) : null,
          todayRecord: today ? recordDTO(today) : null,
          selfEmployeeId: ownId,
          canCheckIn:
            punch &&
            !open &&
            !today &&
            !!own?.active &&
            !!ownRow?.branch_active &&
            own.workDays.includes(time.weekday),
          canCheckOut: punch && !!open,
          schedules: definitions,
          employees: employees.rows,
          branches,
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
        const { companyId, context } = await access(client, req);
        const ownId = context.employee?.id ?? null;
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
        const own = ownId
          ? (
              await client.query(
                schedules + " WHERE s.company_id=$1 AND s.employee_id=$2",
                [companyId, ownId],
              )
            ).rows[0]
          : null;
        const time = await clock(client, own ? scheduleDTO(own) : null);
        const day =
          req.query.day === undefined
            ? time.work_date
            : parse(documentDateSchema, req.query.day);
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
          "employeeName:asc,id:asc",
        );
        const args = [
          companyId,
          day,
          context.general ? employeeId : ownId,
          searchPattern(query.q),
          status,
          time.instant,
        ];
        const sql = `WITH expected AS (
          SELECT e.id AS employee_id,COALESCE(r.employee_name,e.name) AS employee_name,$2::date AS work_date,
            COALESCE(r.branch_name,h.branch_name) AS branch_name,r.checked_in_at,r.checked_out_at,
            COALESCE(r.start_time,h.start_time) AS start_time,COALESCE(r.end_time,h.end_time) AS end_time,
            h.revision AS schedule_revision,h.active AND EXTRACT(DOW FROM $2::date)::smallint=ANY(h.work_days) AS work_day
          FROM employees e
          LEFT JOIN attendance_records r ON r.company_id=e.company_id AND r.employee_id=e.id AND r.work_date=$2::date
          LEFT JOIN LATERAL (SELECT sh.* FROM employee_schedule_history sh WHERE sh.company_id=e.company_id AND sh.employee_id=e.id AND sh.effective_date<=$2::date ORDER BY sh.effective_date DESC,sh.revision DESC LIMIT 1) h ON true
          WHERE e.company_id=$1 AND ($3::integer IS NULL OR e.id=$3) AND (e.active OR r.id IS NOT NULL)
        ),timed AS (
          SELECT *, (work_date+start_time) AT TIME ZONE 'Asia/Aden' AS scheduled_start,
            (work_date+end_time+CASE WHEN end_time<start_time THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE 'Asia/Aden' AS scheduled_end
          FROM expected
        ),computed AS (
          SELECT *,CASE
            WHEN checked_out_at IS NOT NULL THEN 'present'
            WHEN checked_in_at IS NOT NULL THEN CASE WHEN $6::timestamptz>=scheduled_end THEN 'missingCheckout' ELSE 'open' END
            WHEN schedule_revision IS NULL THEN 'unconfigured'
            WHEN NOT work_day THEN 'rest'
            WHEN $6::timestamptz<scheduled_start THEN 'waiting'
            WHEN $6::timestamptz<scheduled_end THEN 'notRecorded'
            ELSE 'absent' END AS status,
            CASE WHEN checked_in_at IS NULL THEN 0 ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM checked_in_at-scheduled_start)/60))::integer END AS late_minutes,
            CASE WHEN checked_out_at IS NULL THEN NULL ELSE FLOOR(EXTRACT(EPOCH FROM checked_out_at-checked_in_at)/60)::integer END AS worked_minutes,
            CASE WHEN checked_out_at IS NULL THEN NULL ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM scheduled_end-checked_out_at)/60))::integer END AS early_leave_minutes
          FROM timed
        ),filtered AS (SELECT * FROM computed WHERE employee_name ILIKE $4 AND ($5='' OR status=$5 OR ($5='late' AND late_minutes>0))) `;
        const summary = (
          await client.query(
            sql +
              `SELECT count(*)::integer AS total,
          count(*) FILTER(WHERE checked_in_at IS NOT NULL)::integer AS attended,
          count(*) FILTER(WHERE status='absent')::integer AS absent,
          count(*) FILTER(WHERE late_minutes>0)::integer AS late,
          count(*) FILTER(WHERE status='missingCheckout')::integer AS "missingCheckout",
          COALESCE(sum(worked_minutes),0)::double precision AS "workedMinutes" FROM filtered`,
            args,
          )
        ).rows[0];
        const rows = (
          await client.query(
            sql +
              `SELECT *,work_date::text AS work_date,start_time::text AS start_time,end_time::text AS end_time FROM filtered f ORDER BY ${query.order} LIMIT $7 OFFSET $8`,
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
          endTime: row.end_time?.slice(0, 5) ?? null,
          status: row.status,
          lateMinutes: row.late_minutes,
          workedMinutes: row.worked_minutes,
          earlyLeaveMinutes: row.early_leave_minutes,
        }));
        return {
          items,
          total: summary.total,
          page: query.page,
          pageSize: query.pageSize,
          day,
          summary,
        };
      });
      res.json(result);
    }),
  );
  router.put(
    base + "/schedules/:employeeId",
    handler(async (req, res) => {
      const input = parse(attendanceScheduleSchema, req.body),
        employeeId = id(req.params.employeeId);
      const schedule = await transaction(pool, async (client) => {
        const { companyId, user, context } = await access(client, req, true);
        manageEmployees(user, context);
        const employee = await client.query(
          "SELECT id FROM employees WHERE company_id=$1 AND id=$2 AND active FOR UPDATE",
          [companyId, employeeId],
        );
        if (!employee.rowCount) missing("الموظف غير موجود أو غير فعال");
        const branch = await client.query(
          "SELECT id FROM branches WHERE company_id=$1 AND id=$2 AND active FOR SHARE",
          [companyId, input.branchId],
        );
        if (!branch.rowCount)
          throw new HttpError(
            400,
            "invalid_branch",
            "اختر فرعًا فعالًا من الشركة",
          );
        const before = (
          await client.query(
            schedules + " WHERE s.company_id=$1 AND s.employee_id=$2",
            [companyId, employeeId],
          )
        ).rows[0];
        if ((before?.revision ?? null) !== input.revision)
          throw new HttpError(
            409,
            "conflict",
            "تغير إعداد الدوام؛ أعد تحميله قبل الحفظ",
          );
        await client.query(
          `INSERT INTO employee_schedules(company_id,employee_id,branch_id,work_days,start_time,end_time,active,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(company_id,employee_id) DO UPDATE SET branch_id=EXCLUDED.branch_id,
    work_days=EXCLUDED.work_days,start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,active=EXCLUDED.active,
    revision=employee_schedules.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
          [
            companyId,
            employeeId,
            input.branchId,
            [...input.workDays].sort(),
            input.startTime,
            input.endTime,
            input.active,
            user.id,
          ],
        );
        const after = scheduleDTO(
          (
            await client.query(
              schedules + " WHERE s.company_id=$1 AND s.employee_id=$2",
              [companyId, employeeId],
            )
          ).rows[0],
        );
        await audit(
          client,
          user,
          "attendance.schedule",
          "employee",
          employeeId,
          before ? scheduleDTO(before) : null,
          after,
          companyId,
        );
        return after;
      });
      res.json({ schedule });
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
        const open = (
          await client.query(
            records +
              " WHERE r.company_id=$1 AND r.employee_id=$2 AND r.checked_out_at IS NULL",
            [companyId, employee.id],
          )
        ).rows[0];
        if (open) return recordDTO(open);
        const row = (
          await client.query(
            schedules + " WHERE s.company_id=$1 AND s.employee_id=$2",
            [companyId, employee.id],
          )
        ).rows[0];
        if (!row?.active || !row.branch_active)
          throw new HttpError(
            409,
            "schedule_required",
            "يلزم إعداد دوامك وفرعك أولًا بواسطة المدير",
          );
        const schedule = scheduleDTO(row),
          time = await clock(client, schedule);
        const existing = (
          await client.query(
            records +
              " WHERE r.company_id=$1 AND r.employee_id=$2 AND r.work_date=$3",
            [companyId, employee.id, time.work_date],
          )
        ).rows[0];
        if (existing) return recordDTO(existing);
        if (!schedule.workDays.includes(time.weekday))
          throw new HttpError(
            409,
            "non_work_day",
            "هذا اليوم غير محدد ضمن أيام دوامك",
          );
        const inserted = await client.query(
          `INSERT INTO attendance_records(company_id,employee_id,employee_name,branch_id,branch_name,work_date,checked_in_at,
    start_time,end_time,schedule_revision,idempotency_key,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
          [
            companyId,
            employee.id,
            employee.name,
            schedule.branchId,
            schedule.branchName,
            time.work_date,
            time.instant,
            schedule.startTime,
            schedule.endTime,
            schedule.revision,
            input.idempotencyKey,
            user.id,
          ],
        );
        const after = recordDTO(
          (
            await client.query(records + " WHERE r.company_id=$1 AND r.id=$2", [
              companyId,
              inserted.rows[0].id,
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
              " WHERE r.company_id=$1 AND r.employee_id=$2 AND r.id=$3 FOR UPDATE",
            [companyId, employee.id, input.recordId],
          )
        ).rows[0];
        if (!row) missing();
        const before = recordDTO(row);
        if (row.checked_out_at) return before;
        await client.query(
          "UPDATE attendance_records SET checked_out_at=clock_timestamp(),revision=revision+1,updated_by=$1,updated_at=clock_timestamp() WHERE company_id=$2 AND id=$3",
          [user.id, companyId, input.recordId],
        );
        const after = recordDTO(
          (
            await client.query(records + " WHERE r.company_id=$1 AND r.id=$2", [
              companyId,
              input.recordId,
            ])
          ).rows[0],
        );
        await audit(
          client,
          user,
          "attendance.checkOut",
          "attendance",
          after.id,
          before,
          after,
          companyId,
        );
        return after;
      });
      res.json({ record });
    }),
  );
  return router;
}
