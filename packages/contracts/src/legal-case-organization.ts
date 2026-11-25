import { z } from "zod";

const positiveId = z.number().int().min(1).max(2147483647);
const sourceIds = (maximum: number) => z.array(positiveId).max(maximum)
  .refine(ids => new Set(ids).size === ids.length, "لا تكرر سجل المصدر");

export const legalCaseFileKinds = [
  "case", "execution", "appeal", "complaint", "arbitration", "dossier", "unresolved",
] as const;

// This profile is a separate administrative view. The original case summary,
// source records and their histories remain untouched.
export const legalCaseProfileSchema = z.object({
  executiveSummary: z.string().trim().max(2000),
  currentAction: z.string().trim().max(2000),
  organizationalNotes: z.array(z.string().trim().min(1).max(1000)).max(30),
  lastAction: z.object({
    description: z.string().trim().min(1).max(2000),
    date: z.iso.date().nullable(),
    sourceRecordIds: sourceIds(100),
  }).strict().nullable(),
  proceedingNumbers: z.array(z.object({
    kind: z.string().trim().min(1).max(80),
    number: z.string().trim().min(1).max(120),
    sourceRecordIds: sourceIds(100),
  }).strict()).max(30),
  sourceRecordIds: sourceIds(200),
  fileKind: z.enum(legalCaseFileKinds).optional(),
  currentStatusDescription: z.string().trim().max(500).optional(),
  canonicalCaseId: positiveId.optional(),
}).strict();

export type LegalCaseProfile = z.infer<typeof legalCaseProfileSchema>;

export const legalCaseOrganizationPatchSchema = z.object({
  revision: positiveId,
  caseProfile: legalCaseProfileSchema.optional(),
  title: z.string().trim().min(1).max(250).optional(),
  caseNumber: z.string().trim().max(120).optional(),
  agency: z.string().trim().max(250).optional(),
  caseType: z.string().trim().max(120).optional(),
}).strict().refine(value => Object.keys(value).some(key => key !== "revision"),
  "حدد بيانات التنظيم المراد تحديثها");

// One symmetric relationship per case pair. Its label must describe the
// relationship from both ends, e.g. "الدعوى ومرحلة الطعن".
// revision=0 creates a relationship only if the pair is not already linked.
export const legalCaseRelationSchema = z.object({
  revision: z.number().int().min(0).max(2147483647),
  relationType: z.string().trim().min(1).max(120),
  evidence: z.string().trim().min(1).max(4000),
  sourceRecordIds: sourceIds(100),
}).strict();

export type LegalCaseRelationInput = z.infer<typeof legalCaseRelationSchema>;

export const legalCaseProfileSourceIds = (profile: LegalCaseProfile): number[] => [
  ...new Set([
    ...profile.sourceRecordIds,
    ...(profile.lastAction?.sourceRecordIds ?? []),
    ...profile.proceedingNumbers.flatMap(item => item.sourceRecordIds),
  ]),
];
