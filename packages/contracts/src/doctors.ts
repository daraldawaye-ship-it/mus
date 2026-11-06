import { z } from "zod";

export const doctorKinds = ["doctor", "nurse", "entity"] as const;
export type DoctorKind = typeof doctorKinds[number];
export const doctorKindLabels: Record<DoctorKind,string> = {
  doctor: "طبيب", nurse: "ممرض", entity: "جهة",
};
const text = (limit: number) => z.string().trim().max(limit);
export const doctorInputSchema = z.object({
  name: text(240).min(1, "أدخل اسم الطبيب أو الجهة"),
  /** Name under which several independent doctor/entity cards are grouped. */
  sharedName: text(240).optional(),
  kind: z.enum(doctorKinds),
  department: text(240).default(""),
  phone: text(60).default(""),
  searchKeys: text(500).default(""),
  notes: text(2000).default(""),
  active: z.boolean().default(true),
}).strict();
/** Change the common name of checked cards to the chosen main card name, atomically. */
export const doctorBulkSharedNameSchema = z.object({
  mainDoctorId: z.number().int().positive(),
  doctorIds: z.array(z.number().int().positive()).min(1).max(500),
}).strict();

export const doctorPatchSchema = doctorInputSchema.extend({
  kind: z.enum(doctorKinds).nullable(),
  revision: z.number().int().positive(),
});
export interface Doctor {
  id: number;
  companyId: number;
  name: string;
  /** Existing cards default to their own name; sharing never merges their IDs. */
  sharedName: string;
  kind: DoctorKind | null;
  department: string;
  phone: string;
  searchKeys: string;
  notes: string;
  active: boolean;
  revision: number;
}

/** Empty/missing shared name keeps each card as its own main card. */
export function effectiveDoctorSharedName(name: string, sharedName?: string | null): string {
  return sharedName?.trim() || name.trim();
}
/** Only a card whose own name equals the shared name is a main card. */
export function isMainDoctorCard(name: string, sharedName?: string | null): boolean {
  return name.trim() === effectiveDoctorSharedName(name, sharedName);
}

/** Single-field updates from the directory table must not overwrite other fields. */
const doctorFieldRevision = z.number().int().positive();
export const doctorInlinePatchSchema = z.discriminatedUnion("field", [
  z.object({field:z.literal("sharedName"),value:text(240),revision:doctorFieldRevision}).strict(),
  z.object({field:z.literal("kind"),value:z.enum(doctorKinds).nullable(),revision:doctorFieldRevision}).strict(),
  z.object({field:z.literal("department"),value:text(240),revision:doctorFieldRevision}).strict(),
  z.object({field:z.literal("phone"),value:text(60),revision:doctorFieldRevision}).strict(),
  z.object({field:z.literal("searchKeys"),value:text(500),revision:doctorFieldRevision}).strict(),
  z.object({field:z.literal("notes"),value:text(2000),revision:doctorFieldRevision}).strict(),
  z.object({field:z.literal("active"),value:z.boolean(),revision:doctorFieldRevision}).strict(),
]);
export type DoctorInlineField = z.infer<typeof doctorInlinePatchSchema>["field"];
