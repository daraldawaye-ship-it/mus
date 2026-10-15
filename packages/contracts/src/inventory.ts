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
export const stockAdjustmentSchema = z
  .object({
    documentDate: documentDateSchema,
    itemId: id,
    locationId: id,
    countedQuantity: itemWholeQuantitySchema,
    expectedQuantitySmallest: stockSmallestQuantitySchema,
    unit,
    expiryDate: documentDateSchema.nullable().default(null),
    unitCostBase: amountSchema.default("0"),
    description: z.string().trim().max(1000).default(""),
    idempotencyKey: z.uuid(),
  })
  .strict();
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
  pooledValueBase: string;
  baseCurrencyCode: string;
}
export interface StockMovement {
  id: number;
  companyId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
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


/** First reservation increment: explicit manual hold with an external reference. */
export const stockReservationSchema = z.object({
 itemId:id,
 locationId:id,
 expiryDate:documentDateSchema.nullable().default(null),
 unit,
 quantity:positiveQuantity,
 sourceType:z.literal("manual").default("manual"),
 sourceReference:z.string().trim().min(1).max(120),
 description:z.string().trim().max(1000).default(""),
 idempotencyKey:z.uuid(),
}).strict();
export const stockReservationReleaseSchema = z.object({
 reason:z.string().trim().min(1).max(1000),
 idempotencyKey:z.uuid(),
}).strict();
export type StockReservationInput=z.input<typeof stockReservationSchema>;
export type StockReservationReleaseInput=z.input<typeof stockReservationReleaseSchema>;
export interface StockReservation {
 id:number;
 companyId:number;
 itemId:number;
 locationId:number;
 expiryDate:string|null;
 unit:1|2|3;
 quantity:string;
 quantitySmallest:string;
 sourceType:"manual";
 sourceReference:string;
 description:string;
 status:"active"|"released";
 reservedBy:number;
 reservedAt:string;
 releasedBy:number|null;
 releasedAt:string|null;
 releaseReason:string|null;
}
export interface StockReservationLotAvailability {
 locationId:number;
 locationName:string;
 expiryDate:string|null;
 physicalSmallest:string;
 reservedSmallest:string;
 availableSmallest:string;
}
export interface StockReservationAvailability {
 companyId:number;
 itemId:number;
 unit1Name:string;
 unit2Name:string;
 unit3Name:string;
 factor2:number;
 factor3:number;
 lots:StockReservationLotAvailability[];
 truncated:boolean;
 reservations:StockReservation[];
 reservationsTruncated:boolean;
}
