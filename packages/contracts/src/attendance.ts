import { z } from "zod";
import type { Page } from "./index.ts";
import { normalizeDigits } from "./masters.ts";
const id = z.number().int().positive().max(2147483647);
const time = z
  .string()
  .trim()
  .transform(normalizeDigits)
  .pipe(z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "الوقت غير صالح"));
export const employeeAttendanceSettingsSchema = z
  .object({
    hourlyPoints: z
      .string()
      .trim()
      .transform(normalizeDigits)
      .pipe(
        z
          .string()
          .regex(
            /^(0|[1-9][0-9]{0,8})$/,
            "نقاط الساعة عدد صحيح لا يتجاوز 999999999",
          ),
      )
      .nullable(),
    defaultDailyHours: z
      .string()
      .trim()
      .transform((value) => normalizeDigits(value).replace(/٫/g, "."))
      .pipe(
        z
          .string()
          .regex(
            /^(0|[1-9][0-9]?)(\.[0-9]{1,2})?$/,
            "الساعات رقم موجب بمنزلتين عشريتين كحد أقصى",
          ),
      )
      .refine((value) => {
        if (!/^(0|[1-9][0-9]?)(\.[0-9]{1,2})?$/.test(value)) return false;
        const [whole, fraction = ""] = value.split(".");
        const hundredths =
          BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
        return hundredths >= 1n && hundredths <= 2400n;
      }, "الساعات بين 0.01 و24")
      .nullable(),
    expectedStartTime: time.nullable(),
    allowOvertime: z.boolean(),
    revision: id.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.hourlyPoints === null ||
      value.hourlyPoints === "0" ||
      value.defaultDailyHours !== null,
    "حدد ساعات اليوم عند تعيين نقاط الساعة",
  );
export const attendanceAdjustmentSchema = z
  .object({
    recordId: id,
    points: z
      .string()
      .trim()
      .transform(normalizeDigits)
      .pipe(
        z
          .string()
          .regex(
            /^-?(0|[1-9][0-9]{0,17})$/,
            "النقاط عدد صحيح لا يتجاوز 18 خانة",
          ),
      )
      .refine((value) => BigInt(value) !== 0n, "التعديل لا يكون صفراً")
      .transform((value) => BigInt(value).toString()),
    reason: z.string().trim().min(1, "سبب التعديل مطلوب").max(500),
    idempotencyKey: z.uuid().transform((value) => value.toLowerCase()),
  })
  .strict();
export type AttendanceAdjustmentInput = z.input<
  typeof attendanceAdjustmentSchema
>;
export interface EmployeeAttendanceSettings {
  employeeId: number;
  hourlyPoints: string | null;
  defaultDailyHours: string | null;
  expectedStartTime: string | null;
  allowOvertime: boolean;
  revision: number | null;
}
// Historical schedule contracts remain readable; flexible attendance does not use them as gates.
export const attendanceScheduleSchema = z
  .object({
    branchId: id,
    workDays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, "أيام العمل مكررة"),
    startTime: time,
    endTime: time,
    active: z.boolean(),
    revision: id.nullable(),
  })
  .strict()
  .refine(
    (value) => value.startTime !== value.endTime,
    "بداية الدوام ونهايته يجب أن تختلفا",
  );
export const attendanceCheckInSchema = z
  .object({
    idempotencyKey: z.uuid().transform((value) => value.toLowerCase()),
  })
  .strict();
export const attendanceCheckOutSchema = z.object({ recordId: id }).strict();
export interface AttendanceSchedule {
  employeeId: number;
  branchId: number;
  branchName: string;
  workDays: number[];
  startTime: string;
  endTime: string;
  active: boolean;
  revision: number;
}
export interface AttendanceRecord {
  id: number;
  employeeId: number;
  employeeName: string;
  branchName: string | null;
  workDate: string;
  checkedInAt: string;
  checkedOutAt: string | null;
  startTime: string | null;
  endTime: string | null;
  revision: number;
  hourlyPoints: string | null;
  defaultDailyHours: string | null;
  expectedStartTime: string | null;
  allowOvertime: boolean;
  settingsRevision: number | null;
  paidSeconds: string;
  points: string;
  closeSource: "manual" | "automatic" | null;
  needsReview: boolean;
}
export interface AttendanceDailySummary {
  closedSeconds: string;
  paidSeconds: string;
  points: string;
  sessionCount: number;
  reviewCount: number;
  defaultDailyHours: string | null;
  allowOvertime: boolean | null;
}
export interface AttendanceDirectory extends Page<AttendanceRecord> {
  today: string;
  workDate: string;
  openRecord: AttendanceRecord | null;
  todayRecord: AttendanceRecord | null;
  selfEmployeeId: number | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  ownSettings: EmployeeAttendanceSettings | null;
  dailySummary: AttendanceDailySummary;
  schedules: AttendanceSchedule[];
  employees: { id: number; name: string }[];
  branches: { id: number; name: string }[];
}
export type AttendanceStatus =
  | "present"
  | "open"
  | "missingCheckout"
  | "absent"
  | "waiting"
  | "notRecorded"
  | "rest"
  | "unconfigured";
export interface AttendanceReportRow {
  id: number;
  employeeId: number;
  employeeName: string;
  branchName: string | null;
  workDate: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  startTime: string | null;
  endTime: string | null;
  status: AttendanceStatus;
  lateMinutes: number;
  workedMinutes: number | null;
  earlyLeaveMinutes: number | null;
  closedSeconds: string;
  paidSeconds: string;
  points: string;
  sessionCount: number;
  reviewCount: number;
}
export interface AttendanceReport extends Page<AttendanceReportRow> {
  day: string;
  summary: {
    total: number;
    attended: number;
    absent: number;
    late: number;
    missingCheckout: number;
    workedMinutes: number;
    closedSeconds: string;
    paidSeconds: string;
    points: string;
    sessionCount: number;
    reviewCount: number;
  };
}
