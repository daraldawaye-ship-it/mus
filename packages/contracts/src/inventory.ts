import { z } from "zod";
import { amountSchema, documentDateSchema } from "./finance.ts";
import { itemWholeQuantitySchema, type ExactQuantity } from "./items.ts";
import { normalizeDigits } from "./masters.ts";

const id = z.number().int().positive().max(2_147_483_647);
const unit = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const positiveQuantity = itemWholeQuantitySchema.refine(
  (value) => BigInt(value) > 0n,
  "الكمية يجب أن تكون موجبة",
);
export const stockSmallestQuantitySchema = z
  .string()
  .trim()
  .transform(normalizeDigits)
  .pipe(
    z
      .string()
      .regex(
        /^\d{1,40}$/,
        "رصيد الأجزاء الأصغر عدد صحيح غير سالب حتى 40 رقمًا",
      ),
  )
  .transform((value) => BigInt(value).toString());
export const inventorySettingsSchema = z
  .object({
    inventoryAccountId: id,
    salesAccountId: id,
    cogsAccountId: id,
    surplusAccountId: id,
    shortageAccountId: id,
    costingMethod: z.literal("weighted_average").default("weighted_average"),
    allowNegative: z.boolean().default(true),
    revision: id.nullable(),
  })
  .strict();
export type InventorySettingsInput = z.input<typeof inventorySettingsSchema>;
export interface InventorySettings {
  companyId: number;
  inventoryAccountId: number;
  salesAccountId: number;
  cogsAccountId: number;
  surplusAccountId: number;
  shortageAccountId: number;
  costingMethod: "weighted_average";
  allowNegative: boolean;
  revision: number;
  baseCurrencyId: number | null;
  baseCurrencyCode: string | null;
  baseDecimalPlaces: number | null;
}
export const stockTransferSchema = z
  .object({
    documentDate: documentDateSchema,
    itemId: id,
    fromLocationId: id,
    toLocationId: id,
    quantity: positiveQuantity,
    unit,
    expiryDate: documentDateSchema.nullable().default(null),
    description: z.string().trim().max(1000).default(""),
    idempotencyKey: z.uuid(),
  })
  .strict()
  .refine((value) => value.fromLocationId !== value.toLocationId, {
    path: ["toLocationId"],
    message: "اختر موقعًا مختلفًا لاستلام المناقلة",
  });
/** Convert an exact physical count across all active unit sizes to the persisted smallest unit. */
export function countedStockSmallest(
  counts: { unit1: string; unit2?: string; unit3?: string },
  factors: { factor2: number; factor3: number },
): bigint {
  return BigInt(counts.unit1) * BigInt(factors.factor2) * BigInt(factors.factor3)
    + BigInt(counts.unit2 ?? "0") * BigInt(factors.factor3)
    + BigInt(counts.unit3 ?? "0");
}
export const stockAdjustmentSchema = z
  .object({
    documentDate: documentDateSchema,
    itemId: id,
    locationId: id,
    countedQuantity: itemWholeQuantitySchema.optional(),
    countedUnits: z.object({
      unit1: itemWholeQuantitySchema,
      unit2: itemWholeQuantitySchema.optional(),
      unit3: itemWholeQuantitySchema.optional(),
    }).strict().optional(),
    nearestExpiryDate: documentDateSchema.nullable().optional(),
    shelfId: id.nullable().optional(),
    /** Zero the selected location without changing shelf or item-card expiry. */
    zeroLocation: z.boolean().optional(),
    expectedQuantitySmallest: stockSmallestQuantitySchema,
    unit,
    expiryDate: documentDateSchema.nullable().default(null),
    unitCostBase: amountSchema.optional(),
    description: z.string().trim().max(1000).default(""),
    idempotencyKey: z.uuid(),
  })
  .strict()
  .refine(value => value.countedQuantity !== undefined || value.countedUnits !== undefined, {
    path: ["countedUnits"],
    message: "أدخل الكمية الفعلية للوحدات قبل الترحيل",
  });
export type StockTransferInput = z.input<typeof stockTransferSchema>;
export type StockAdjustmentInput = z.input<typeof stockAdjustmentSchema>;
export const stockMovementKinds = [
  "purchase",
  "sale",
  "sales_return",
  "purchase_return",
  "transfer_in",
  "transfer_out",
  "adjustment_surplus",
  "adjustment_shortage",
  "reversal",
] as const;
export type StockMovementKind = (typeof stockMovementKinds)[number];
export const stockMovementKindLabels: Record<StockMovementKind, string> = {
  purchase: "شراء",
  sale: "بيع",
  sales_return: "مردود مبيعات",
  purchase_return: "مردود مشتريات",
  transfer_in: "مناقلة واردة",
  transfer_out: "مناقلة صادرة",
  adjustment_surplus: "زيادة جرد",
  adjustment_shortage: "عجز جرد",
  reversal: "عكس حركة",
};
export interface StockBalance {
  id: number;
  companyId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  locationId: number;
  locationName: string;
  branchName: string;
  expiryDate: string | null;
  quantitySmallest: string;
  quantityUnit1: ExactQuantity;
  unit1Name: string;
  unit2Name: string;
  unit3Name: string;
  factor2: number;
  factor3: number;
  pooledQuantitySmallest: string;
  /** Permission-scoped stock coverage in days; null when hidden. */
  approximateCoverageDays?: string | null;
  coverageAfterReserveDays?: string | null;
  pooledValueBase: string;
  baseCurrencyCode: string;
}
export interface StockMovement {
  id: number;
  companyId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  supplierAccountId: number | null;
  supplierAccountCode: string | null;
  supplierAccountName: string | null;
  /** If populated from old history, records the provenance of the guess. */
  supplierInferenceSource: "invoice" | "prior_purchase" | "item_estimate" | null;
  locationId: number;
  locationName: string;
  branchId: number;
  branchName: string;
  expiryDate: string | null;
  quantitySmallest: string;
  costBase: string;
  kind: StockMovementKind;
  documentDate: string;
  invoiceId: number | null;
  invoiceLineId: number | null;
  originalMovementId: number | null;
  operationId: number | null;
  createdBy: number;
  createdByName: string;
  createdAt: string;
}
export interface StockOperation {
  id: number;
  companyId: number;
  kind: "transfer" | "adjustment";
  documentDate: string;
  description: string;
  financialDocumentId: number | null;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  movements: StockMovement[];
}
export const inventoryCatalog = { stockMovementKinds, stockMovementKindLabels };
