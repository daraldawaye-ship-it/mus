import { z } from "zod";
import type { Page } from "./index.ts";
const id = z.number().int().positive().max(2147483647);
const time = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "الوقت غير صالح");
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
  .object({ idempotencyKey: z.uuid() })
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
  branchName: string;
  workDate: string;
  checkedInAt: string;
  checkedOutAt: string | null;
  startTime: string;
  endTime: string;
  revision: number;
}
export interface AttendanceDirectory extends Page<AttendanceRecord> {
  today: string;
  workDate: string;
  openRecord: AttendanceRecord | null;
  todayRecord: AttendanceRecord | null;
  selfEmployeeId: number | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  schedules: AttendanceSchedule[];
  employees: { id: number; name: string }[];
  branches: { id: number; name: string }[];
}
