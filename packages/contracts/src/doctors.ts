import { z } from "zod";

export const doctorKinds = ["doctor", "nurse", "entity"] as const;
export type DoctorKind = typeof doctorKinds[number];
export const doctorKindLabels: Record<DoctorKind,string> = {
  doctor: "طبيب", nurse: "ممرض", entity: "جهة",
};
const text = (limit: number) => z.string().trim().max(limit);
export const doctorInputSchema = z.object({
  name: text(240).min(1, "أدخل اسم الطبيب أو الجهة"),
  kind: z.enum(doctorKinds),
  department: text(240).default(""),
  phone: text(60).default(""),
  searchKeys: text(500).default(""),
  notes: text(2000).default(""),
  active: z.boolean().default(true),
}).strict();
export const doctorPatchSchema = doctorInputSchema.extend({
  kind: z.enum(doctorKinds).nullable(),
  revision: z.number().int().positive(),
});
export interface Doctor {
  id: number;
  companyId: number;
  name: string;
  kind: DoctorKind | null;
  department: string;
  phone: string;
  searchKeys: string;
  notes: string;
  active: boolean;
  revision: number;
}
