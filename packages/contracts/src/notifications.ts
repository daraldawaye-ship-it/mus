import { z } from "zod";
import type { Page } from "./index.ts";
const id = z.number().int().positive().max(2147483647);
export const importanceSchema = z.enum(["low", "medium", "high", "critical"]);
export const repeatIntervalSchema = z.enum(["none", "day", "week", "month"]);
export type NotificationImportance = z.infer<typeof importanceSchema>;
export type NotificationRepeat = z.infer<typeof repeatIntervalSchema>;
export const notificationSettingsSchema = z
  .object({
    importance: importanceSchema,
    enabled: z.boolean(),
    canSnooze: z.boolean(),
    allowRepeat: z.boolean(),
    repeatInterval: repeatIntervalSchema,
    notifyManagers: z.boolean(),
    notifySubject: z.boolean(),
    roleIds: z
      .array(id)
      .max(100)
      .refine((x) => new Set(x).size === x.length),
    employeeIds: z
      .array(id)
      .max(100)
      .refine((x) => new Set(x).size === x.length),
    revision: id.nullable(),
  })
  .strict()
  .refine(
    (x) => x.allowRepeat || x.repeatInterval === "none",
    "فعّل السماح بالتكرار أولًا",
  );
export const notificationActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("priority"),
      revision: id,
      importance: importanceSchema,
    })
    .strict(),
  z.object({ action: z.literal("read"), revision: id }).strict(),
  z.object({ action: z.literal("complete"), revision: id }).strict(),
  z
    .object({
      action: z.literal("snooze"),
      revision: id,
      until: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      action: z.literal("repeat"),
      revision: id,
      repeatInterval: repeatIntervalSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("assign"),
      revision: id,
      employeeId: id,
      repeatInterval: repeatIntervalSchema,
    })
    .strict(),
]);
export interface NotificationTemplate {
  code: string;
  name: string;
  category: string;
  scope: "public" | "company";
  description: string;
  implemented: boolean;
  canDisable: boolean;
  importance: NotificationImportance;
  enabled: boolean;
  canSnooze: boolean;
  allowRepeat: boolean;
  repeatInterval: NotificationRepeat;
  notifyManagers: boolean;
  notifySubject: boolean;
  roleIds: number[];
  employeeIds: number[];
  revision: number | null;
}
export interface NotificationTemplateDirectory {
  templates: NotificationTemplate[];
  employees: { id: number; name: string }[];
  roles: { id: number; name: string }[];
}
export interface NotificationRecord {
  id: number;
  code: string;
  title: string;
  message: string;
  importance: NotificationImportance;
  companyId: number | null;
  createdAt: string;
  readAt: string | null;
  completedAt: string | null;
  snoozedUntil: string | null;
  repeatInterval: NotificationRepeat;
  reminderCount: number;
  revision: number;
  subjectEmployeeId: number | null;
  canSnooze: boolean;
  canAssign: boolean;
  canRepeat: boolean;
  href: string | null;
}
export interface NotificationDirectory extends Page<NotificationRecord> {
  unread: number;
  employees: { id: number; name: string }[];
}
