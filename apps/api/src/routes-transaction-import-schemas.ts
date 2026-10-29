import { z } from "zod";
import {
  documentDateSchema,
  invoiceSchema,
  invoiceLineSchema,
  financialDocumentSchema,
} from "../../../packages/contracts/src/index.ts";

const importedInvoiceSchema = invoiceSchema.safeExtend({
  lines: z.array(invoiceLineSchema).min(1).max(200),
});
const sourceFields = {
  sourceId: z.string().min(1).max(100),
  sourceDocumentNumber: z.string().min(1).max(100),
  sourceCreatedAt: z.string().min(1).max(40),
  sourceCreators: z.array(z.string().max(120)).min(1).max(20),
  sourceMovementIds: z.array(z.string().min(1).max(100)).min(1).max(500),
  sourceRows: z
    .array(z.record(z.string().max(120), z.string().max(4000)))
    .min(1)
    .max(200),
};
const importedDocumentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("invoice"),
      ...sourceFields,
      payload: importedInvoiceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("voucher"),
      ...sourceFields,
      payload: financialDocumentSchema,
    })
    .strict(),
]);
export const batchSchema = z
  .object({
    idempotencyKey: z.uuid(),
    sourceSystem: z.string().trim().min(1).max(100),
    postingDate: documentDateSchema,
    preserveDocumentDates: z.boolean().optional(),
    documents: z.array(importedDocumentSchema).min(1).max(300),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.documents.forEach((doc, index) => {
      const key = doc.type + ":" + doc.sourceId;
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: ["documents", index, "sourceId"],
          message: "هوية المصدر مكررة داخل الدفعة",
        });
      seen.add(key);
      if (!value.preserveDocumentDates && doc.payload.documentDate !== value.postingDate)
        context.addIssue({
          code: "custom",
          path: ["documents", index, "payload", "documentDate"],
          message: "تاريخ المستند يجب أن يطابق تاريخ ترحيل الدفعة",
        });
    });
  });
// Initial historical intake is intentionally more permissive than normal invoice posting.
// Its quantities may be fractional (up to six decimals). They are preserved
// as historical source data and are NOT passed to stock or accounting yet.
const stagedQuantitySchema = z.string().trim()
  .regex(/^-?\d{1,22}(?:\.\d{1,6})?$/, "الكمية حتى 6 منازل عشرية")
  .refine(value => !/^-?0(?:\.0+)?$/.test(value), "الكمية لا تساوي صفرًا");
const stagedLineSchema = invoiceLineSchema.safeExtend({ quantity: stagedQuantitySchema });
const stagedInvoiceSchema = z.object({
  ...invoiceSchema.shape,
  lines: z.array(stagedLineSchema).min(1).max(200),
}).strict();
const stagedDocumentSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("invoice"), ...sourceFields, payload: stagedInvoiceSchema}).strict(),
  z.object({type: z.literal("voucher"), ...sourceFields, payload: financialDocumentSchema}).strict(),
]);
export const stagingBatchSchema = z.object({
  ...batchSchema.shape,
  documents: z.array(stagedDocumentSchema).min(1).max(300),
  preserveDocumentDates: z.boolean().optional(),
}).strict().superRefine((batch, context) => {
  const identities = new Set<string>();
  batch.documents.forEach((doc, index) => {
    const key = doc.type + ":" + doc.sourceId;
    if (identities.has(key)) context.addIssue({code:"custom",path:["documents",index,"sourceId"],message:"هوية المصدر مكررة داخل الدفعة"});
    identities.add(key);
    if (!batch.preserveDocumentDates && doc.payload.documentDate !== batch.postingDate)
      context.addIssue({code:"custom",path:["documents",index,"payload","documentDate"],message:"تاريخ المستند لا يطابق تاريخ الدفعة"});
  });
});


