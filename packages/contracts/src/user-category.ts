import { z } from "zod";

export const userCategories = [
  "مستخدم",
  "دكتور جامعه",
  "طبيب",
  "طالب صيدله / طب",
  "صيدلي",
  "صيدلي موظف في صيدليه",
  "مالك صيدليه",
  "مندوب شركه",
  "متحصل شركه",
  "سوبر فايزر شركة",
  "موظف في شركة - وكيل",
  "مالك شركة - وكيل",
  "مالك محل جمله",
  "موظف في محل جمله",
  "موظف في مستشفى",
  "موظف في عيادة",
  "موزع شخصي",
] as const;

export const defaultUserCategory = userCategories[0];
export const userCategorySchema = z.enum(userCategories);
export type UserCategory = (typeof userCategories)[number];

export function normalizeReferralCategory(category: string): string {
  switch (category) {
    case "طالب صيدليه": return "طالب صيدله / طب";
    case "موزع ادويه - شخصي": return "موزع شخصي";
    default: return category;
  }
}
