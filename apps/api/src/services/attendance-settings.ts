import type { Database } from "../db.ts";
import type {
  EmployeeAttendanceSettings,
  User,
  employeeAttendanceSettingsSchema,
} from "../../../../packages/contracts/src/index.ts";
import type { z } from "zod";
import { HttpError } from "../errors.ts";
import { audit } from "./audit.ts";

/** The absence of a profile never invents a rate, schedule or work-day limit. */
export async function getAttendanceSettings(
  db: Database,
  companyId: number,
  employeeId: number,
): Promise<EmployeeAttendanceSettings> {
  const row = (
    await db.query(
      `SELECT hourly_points::text,default_daily_hours::text,
        expected_start_time::text,allow_overtime,revision
       FROM employee_attendance_settings WHERE company_id=$1 AND employee_id=$2`,
      [companyId, employeeId],
    )
  ).rows[0];
  return {
    employeeId,
    hourlyPoints: row?.hourly_points ?? null,
    defaultDailyHours: row?.default_daily_hours
      ? row.default_daily_hours
          .replace(/\.0+$/, "")
          .replace(/(\.\d*?)0+$/, "$1")
      : null,
    expectedStartTime: row?.expected_start_time?.slice(0, 5) ?? null,
    allowOvertime: row?.allow_overtime ?? false,
    revision: row?.revision ?? null,
  };
}

/** Caller holds the company write lock and has verified employee/admin access. */
export async function saveAttendanceSettings(
  db: Database,
  user: User,
  companyId: number,
  employeeId: number,
  input: z.output<typeof employeeAttendanceSettingsSchema>,
): Promise<EmployeeAttendanceSettings> {
  const before = await getAttendanceSettings(db, companyId, employeeId);
  if (before.revision !== input.revision)
    throw new HttpError(
      409,
      "conflict",
      "تغيرت إعدادات دوام الموظف؛ أعد تحميلها قبل الحفظ",
    );
  await db.query(
    `INSERT INTO employee_attendance_settings
       (company_id,employee_id,hourly_points,default_daily_hours,expected_start_time,
        allow_overtime,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT(company_id,employee_id) DO UPDATE SET
       hourly_points=EXCLUDED.hourly_points,
       default_daily_hours=EXCLUDED.default_daily_hours,
       expected_start_time=EXCLUDED.expected_start_time,
       allow_overtime=EXCLUDED.allow_overtime,
       revision=employee_attendance_settings.revision+1,
       updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
    [
      companyId,
      employeeId,
      input.hourlyPoints,
      input.defaultDailyHours,
      input.expectedStartTime,
      input.allowOvertime,
      user.id,
    ],
  );
  const after = await getAttendanceSettings(db, companyId, employeeId);
  await audit(
    db,
    user,
    "attendance.settings",
    "employee",
    employeeId,
    before.revision === null ? null : before,
    after,
    companyId,
  );
  return after;
}
