import { z } from "zod";

export const userSiteTraits = [
  "admin1", "companyEmployee", "editor", "marketSupervisor", "member",
  "chatAllowed", "chatGrantor", "child", "legalCasesAllowed", "approved", "personallyKnown", "monitor",
] as const;

export type UserSiteTrait = (typeof userSiteTraits)[number];

export const userSiteTraitLabels: Record<UserSiteTrait, string> = {
  admin1: "اداري1",
  companyEmployee: "موظف في شركه",
  editor: "محرر",
  marketSupervisor: "مشرف في السوق",
  member: "عضو",
  chatAllowed: "مسموح في الدردشه",
  chatGrantor: "مانح صلاحيات الدردشة",
  child: "طفل",
  legalCasesAllowed: "مسموح في القضايا",
  approved: "معتمد",
  personallyKnown: "معروف شخصيا",
  monitor: "مراقب",
};

const traits = z.array(z.enum(userSiteTraits)).max(userSiteTraits.length)
  .refine(values => new Set(values).size === values.length, "لا تكرر الصفة.");
const revision = z.number().int().min(0).max(2147483646);
export const userSiteTraitsPatchSchema = z.object({ traits, expectedRevision: revision }).strict();
export const userSiteTraitsResponseSchema = z.object({ traits, revision: z.number().int().min(0).max(2147483647) }).strict();
export type UserSiteTraitsResponse = z.infer<typeof userSiteTraitsResponseSchema>;
