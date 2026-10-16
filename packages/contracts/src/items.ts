import { z } from "zod";
import { normalizeDigits } from "./masters.ts";
import { amountSchema, documentDateSchema } from "./finance.ts";

const id = z.number().int().positive().max(2_147_483_647);
const name = z.string().trim().min(1, "الاسم مطلوب").max(120);
const revision = z.number().int().positive().max(2_147_483_647);
export const ITEM_FACTOR_MAX = 1_000_000;
export const itemFactorSchema = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .transform(normalizeDigits)
      .pipe(z.string().regex(/^\d{1,7}$/, "العامل عدد صحيح موجب"))
      .transform((value) => Number(value)),
  ])
  .pipe(z.number().int().min(1).max(ITEM_FACTOR_MAX));
export const itemWholeQuantitySchema = z
  .string()
  .trim()
  .transform(normalizeDigits)
  .pipe(
    z.string().regex(/^\d{1,22}$/, "الكمية عدد صحيح موجب أو صفر حتى 22 رقمًا"),
  )
  .transform((value) => BigInt(value).toString());
const phone = z
  .string()
  .trim()
  .max(40)
  .transform((value) => normalizeDigits(value.replace(/[\s()\-]/g, "")))
  .refine(
    (value) => value === "" || /^\+?[0-9]{3,20}$/.test(value),
    "رقم الهاتف غير صالح",
  );

const agentFields = z
  .object({
    name,
    phone: phone.default(""),
    address: z.string().trim().max(500).default(""),
    notes: z.string().trim().max(1000).default(""),
    active: z.boolean().default(true),
  })
  .strict();
export const itemAgentSchema = agentFields
  .extend({ idempotencyKey: z.uuid() })
  .strict();
export const itemAgentPatchSchema = agentFields.extend({ revision }).strict();

// Composition is a reusable company-scoped item classification. Its
// substitution flags are descriptive; they never auto-replace stock lines.
const compositionName = z.string().trim().min(1, "الاسم مطلوب").max(240);
const compositionFields = z.object({
  arabicName: compositionName,
  englishName: compositionName,
  description: z.string().trim().max(2000).default(""),
  active: z.boolean().default(true),
  identicalAlternative: z.boolean().default(false),
  nonInterchangeable: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (value.identicalAlternative && value.nonInterchangeable)
    ctx.addIssue({ code: "custom", path: ["nonInterchangeable"],
      message: "لا يمكن تحديد البديل المطابق وغير القابل للتبديل معًا" });
});
export const itemCompositionSchema = compositionFields.safeExtend({ idempotencyKey: z.uuid() });
export const itemCompositionPatchSchema = compositionFields.safeExtend({ revision });
export type ItemCompositionInput = z.input<typeof itemCompositionSchema>;
export type ItemCompositionPatchInput = z.input<typeof itemCompositionPatchSchema>;
export interface ItemComposition {
  id: number;
  companyId: number;
  revision: number;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  arabicName: string;
  englishName: string;
  description: string;
  active: boolean;
  identicalAlternative: boolean;
  nonInterchangeable: boolean;
}

export const arabicShelfLetters = [
  "ا","ب","ت","ث","ج","ح","خ","د","ذ","ر","ز","س","ش",
  "ص","ض","ط","ظ","ع","غ","ف","ق","ك","ل","م","ن","ه","و","ي",
] as const;
export type ArabicShelfLetter = (typeof arabicShelfLetters)[number];
export const itemShelfPatchSchema = z.object({
  revision,
  archived: z.boolean(),
  vitrine: z.boolean(),
}).strict();
export interface ItemShelf {
  id: number;
  companyId: number;
  name: string;
  groupLetter: ArabicShelfLetter;
  groupOrder: number;
  slotNumber: number;
  archived: boolean;
  vitrine: boolean;
  revision: number;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

const commissionPercent = z.string().trim().transform(normalizeDigits)
  .pipe(z.string().regex(/^\d{1,3}(?:\.\d{1,4})?$/, "نسبة العمولة يجب أن تكون بين 0 و100 بأربع منازل كحد أقصى"))
  .refine((value) => {
    const [integer, fraction = ""] = value.split(".");
    return Number(integer) < 100 || (integer === "100" && (!fraction || /^0+$/.test(fraction)));
  }, "نسبة العمولة لا تتجاوز 100%");
const defaultSaleUnitSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const itemFields = z
  .object({
    name,
    imageId: z.uuid().nullable().default(null),
    englishName: z.string().trim().max(120).default(""),
    shelf: z.string().trim().max(100).default(""),
    shelfId: id.nullable().default(null),
    barcode: z.string().trim().max(80).transform(normalizeDigits).default(""),
    legacyId: z.string().trim().max(100).default(""),
    agentId: id.nullable().default(null),
    supplierAccountId: id.nullable().default(null),
    compositionId: id.nullable().default(null),
    unit1Name: name.default("باكت"),
    unit2Name: z.string().trim().max(120).default(""),
    unit3Name: z.string().trim().max(120).default(""),
    factor2: itemFactorSchema.default(1),
    factor3: itemFactorSchema.default(1),
    defaultSaleUnit: defaultSaleUnitSchema.default(1),
    salePrice1: amountSchema.default("0"),
    salePrice2: amountSchema.default("0"),
    salePrice3: amountSchema.default("0"),
    purchasePrice: amountSchema.default("0"),
    commissionRate: commissionPercent.default("0"),
    clearanceFrom: documentDateSchema.nullable().default(null),
    clearanceTo: documentDateSchema.nullable().default(null),
    settlementApprovalDate: documentDateSchema.nullable().default(null),
    settlementDisplayDate: documentDateSchema.nullable().default(null),
    purchaseFactor: itemFactorSchema.default(1),
    currencyId: id,
    reorderLimit: itemWholeQuantitySchema.default("0"),
    orderQuantity: itemWholeQuantitySchema.default("0"),
    reserveQuantity: itemWholeQuantitySchema.default("0"),
    searchKeys: z.string().trim().max(1000).default(""),
    purchaseNotes: z.string().trim().max(1000).default(""),
    orderStoppedUntil: documentDateSchema.nullable().default(null),
    hasExpiry: z.boolean().default(true),
    active: z.boolean().default(true),
  })
  .strict();
function validateNames(
  value: {
    factor2: number;
    factor3: number;
    unit2Name: string;
    unit3Name: string;
    defaultSaleUnit?: 1 | 2 | 3;
    commissionRate: string;
    clearanceFrom: string | null;
    clearanceTo: string | null;
  },
  context: z.RefinementCtx,
) {
  if (value.commissionRate !== "0" && (!value.clearanceFrom || !value.clearanceTo))
    context.addIssue({ code: "custom", path: ["clearanceFrom"], message: "حدد بداية ونهاية فترة التصريف لتفعيل العمولة" });
  if (value.clearanceFrom && value.clearanceTo && value.clearanceFrom > value.clearanceTo)
    context.addIssue({ code: "custom", path: ["clearanceTo"], message: "تاريخ نهاية التصريف لا يسبق بدايته" });
  if (value.factor2 > 1 && !value.unit2Name)
    context.addIssue({
      code: "custom",
      path: ["unit2Name"],
      message: "اسم الوحدة الثانية مطلوب عند تفعيل التجزئة",
    });
  if (value.factor3 > 1 && !value.unit3Name)
    context.addIssue({
      code: "custom",
      path: ["unit3Name"],
      message: "اسم الوحدة الثالثة مطلوب عند تفعيل التجزئة",
    });
  if (
    (value.defaultSaleUnit === 2 && (value.factor2 <= 1 || !value.unit2Name)) ||
    (value.defaultSaleUnit === 3 && (value.factor3 <= 1 || !value.unit3Name))
  )
    context.addIssue({
      code: "custom",
      path: ["defaultSaleUnit"],
      message: "اختر وحدة مفعلة كوحدة افتراضية للمبيعات",
    });
}
export const itemSchema = itemFields
  .extend({ idempotencyKey: z.uuid() })
  .strict()
  .superRefine(validateNames);
export const itemPatchSchema = itemFields
  .extend({
    revision,
    legacyId: z.string().trim().max(100).optional(),
    defaultSaleUnit: defaultSaleUnitSchema.optional(),
    compositionId: id.nullable().optional(),
    shelfId: id.nullable().optional(),
    reserveQuantity: itemWholeQuantitySchema.optional(),
    supplierAccountId: id.nullable().optional(),
  })
  .strict()
  .superRefine(validateNames);
export type ItemInput = z.input<typeof itemSchema>;
export type ItemPatchInput = z.input<typeof itemPatchSchema>;
export type ItemAgentInput = z.input<typeof itemAgentSchema>;
export type ItemAgentPatchInput = z.input<typeof itemAgentPatchSchema>;

interface ItemIdentity {
  id: number;
  companyId: number;
  revision: number;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}
export interface ItemAgent extends ItemIdentity {
  name: string;
  phone: string;
  address: string;
  notes: string;
  active: boolean;
}
export interface Item extends ItemIdentity {
  code: string;
  imageId: string | null;
  name: string;
  englishName: string;
  shelf: string;
  shelfId: number | null;
  barcode: string;
  legacyId: string;
  agentId: number | null;
  supplierAccountId: number | null;
  /** True only when the existing item's supplier was inferred from history. */
  supplierInferred: boolean;
  supplierAccountCode: string | null;
  supplierAccountName: string | null;
  compositionId: number | null;
  compositionArabicName: string | null;
  compositionEnglishName: string | null;
  compositionActive: boolean | null;
  agentName: string | null;
  agentActive: boolean | null;
  unit1Name: string;
  unit2Name: string;
  unit3Name: string;
  factor2: number;
  factor3: number;
  defaultSaleUnit: 1 | 2 | 3;
  salePrice1: string;
  salePrice2: string;
  salePrice3: string;
  purchasePrice: string;
  commissionRate: string;
  clearanceFrom: string | null;
  clearanceTo: string | null;
  settlementApprovalDate: string | null;
  settlementDisplayDate: string | null;
  purchaseFactor: number;
  currencyId: number;
  currencyCode: string;
  currencyName: string;
  currencyDecimalPlaces: number;
  currencyActive: boolean;
  reorderLimit: string;
  orderQuantity: string;
  /** Exact quantity in the smallest enabled item unit. */
  reserveQuantity: string;
  /** Combined available stock in exact smallest-unit integers; null without stock access. */
  availableSmallest?: string | null;
  /** Permission-scoped derived days; populated on the primary items list. */
  approximateCoverageDays?: string | null;
  coverageAfterReserveDays?: string | null;
  searchKeys: string;
  purchaseNotes: string;
  orderStoppedUntil: string | null;
  hasExpiry: boolean;
  nearestExpiryDate: string | null;
  active: boolean;
}

export const itemConversionSchema = z
  .object({
    quantity: itemWholeQuantitySchema,
    unit: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })
  .strict();
export interface ExactQuantity {
  numerator: string;
  denominator: string;
  decimal: string | null;
}
export interface ItemConversion {
  smallestUnits: string;
  unit1: ExactQuantity;
  unit2: ExactQuantity;
  unit3: ExactQuantity;
  parts: { unit1: string; unit2: string; unit3: string };
}

function exactRatio(numerator: bigint, denominator: bigint): ExactQuantity {
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  const reducedNumerator = numerator / a;
  const reducedDenominator = denominator / a;
  let remainder = reducedDenominator;
  let twos = 0;
  let fives = 0;
  while (remainder % 2n === 0n) {
    remainder /= 2n;
    twos++;
  }
  while (remainder % 5n === 0n) {
    remainder /= 5n;
    fives++;
  }
  let decimal: string | null = null;
  if (remainder === 1n) {
    const scale = Math.max(twos, fives);
    if (scale === 0) decimal = reducedNumerator.toString();
    else {
      const digits = (
        (reducedNumerator * 10n ** BigInt(scale)) /
        reducedDenominator
      )
        .toString()
        .padStart(scale + 1, "0");
      const fraction = digits.slice(-scale).replace(/0+$/, "");
      decimal = digits.slice(0, -scale) + (fraction ? `.${fraction}` : "");
    }
  }
  return {
    numerator: reducedNumerator.toString(),
    denominator: reducedDenominator.toString(),
    decimal,
  };
}

/** Conversion preview only: no stock balance, money rounding or database mutation. */
export function convertItemQuantity(
  input: z.input<typeof itemConversionSchema>,
  factors: { factor2: number; factor3: number },
): ItemConversion {
  const { quantity, unit } = itemConversionSchema.parse(input);
  const factor2 = itemFactorSchema.parse(factors.factor2);
  const factor3 = itemFactorSchema.parse(factors.factor3);
  if ((unit === 2 && factor2 === 1) || (unit === 3 && factor3 === 1))
    throw new Error("الوحدة غير مفعلة؛ عامل التجزئة يساوي 1");
  const f2 = BigInt(factor2),
    f3 = BigInt(factor3);
  const pack = f2 * f3;
  const smallest =
    BigInt(quantity) * (unit === 1 ? pack : unit === 2 ? f3 : 1n);
  const remainder = smallest % pack;
  return {
    smallestUnits: smallest.toString(),
    unit1: exactRatio(smallest, pack),
    unit2: exactRatio(smallest, f3),
    unit3: exactRatio(smallest, 1n),
    parts: {
      unit1: (smallest / pack).toString(),
      unit2: (remainder / f3).toString(),
      unit3: (remainder % f3).toString(),
    },
  };
}

export const itemCatalog = {
  itemDefaults: {
    unit1Name: "باكت",
    unit2Name: "",
    unit3Name: "",
    factor2: 1,
    factor3: 1,
    defaultSaleUnit: 1,
    salePrice1: "0",
    salePrice2: "0",
    salePrice3: "0",
    purchasePrice: "0",
    commissionRate: "0",
    clearanceFrom: null,
    clearanceTo: null,
    settlementApprovalDate: null,
    settlementDisplayDate: null,
    purchaseFactor: 1,
    reorderLimit: "0",
    orderQuantity: "0",
    reserveQuantity: "0",
    hasExpiry: true,
    active: true,
  },
  itemFactorMax: ITEM_FACTOR_MAX,
};

/** First statistics increment: derived current balances and references to immutable history. */
export interface ItemStatisticsInvoice {
  invoiceId: number;
  invoiceNumber: string;
  documentDate: string;
  createdAt: string;
  userName: string;
}
export interface ItemStatistics {
  itemId: number;
  companyId: number;
  updatedAt: string;
  canViewStock: boolean;
  canViewCommerce: boolean;
  stock: {
    total: string;
    showroom: string;
    warehouse: string;
    unitName: string;
  } | null;
  lastMovement: {
    id: number;
    kind: string;
    documentDate: string;
    createdAt: string;
  } | null;
  lastSale: ItemStatisticsInvoice | null;
  lastPurchase:
    | (ItemStatisticsInvoice & {
        price: string;
        unitName: string;
        currencyCode: string;
        accountName: string;
      })
    | null;
  adjustmentCounts: {
    allTime: string;
    sinceApproval: string;
    sinceDisplay: string;
    approvalDate: string | null;
    displayDate: string | null;
    lastShowroomAt: string | null;
  } | null;
  lastAdjustment: {
    id: number;
    documentDate: string;
    createdAt: string;
    userName: string;
  } | null;
}

/** Derived invoice activity; values stay exact strings in the smallest item unit. */
export interface ItemActivityPeriod {
  saleInvoices: string;
  saleReturnInvoices: string;
  saleLines: string;
  saleReturnLines: string;
  saleQuantity: string;
  saleReturnQuantity: string;
  purchaseInvoices: string;
  purchaseReturnInvoices: string;
  purchaseLines: string;
  purchaseReturnLines: string;
  purchaseQuantity: string;
  purchaseReturnQuantity: string;
}
export interface ItemActivity {
  companyId: number;
  itemId: number;
  asOf: string;
  unitName: string;
  canViewCommerce: boolean;
  periods: {
    oneMonth: ItemActivityPeriod;
    fourMonths: ItemActivityPeriod;
    twelveMonths: ItemActivityPeriod;
    allTime: ItemActivityPeriod;
  } | null;
}

/** Coverage uses current stock and net sales from the daily activity aggregates. */
export interface ItemCoverage {
  companyId: number;
  itemId: number;
  asOf: string;
  unitName: string;
  canViewCoverage: boolean;
  approximateCoverageDays: string | null;
  coverageAfterReserveDays: string | null;
}

/** Comparable historical price, in company base currency per smallest item unit. */
export interface ItemPurchasePricePoint {
 invoiceId: number;
 invoiceLineId: number;
 invoiceNumber: string;
 documentDate: string;
 originalUnitPrice: string;
 originalUnitName: string;
 originalCurrencyCode: string;
 priceBaseSmallest: string;
 supplierAccountId: number | null;
 supplierAccountName: string | null;
}
export interface ItemPurchasePriceStatistics {
 companyId: number;
 itemId: number;
 asOf: string;
 from: string;
 baseCurrencyCode: string | null;
 smallestUnitName: string;
 canViewPrices: boolean;
 hasOtherBaseCurrencyHistory: boolean;
 minimum: ItemPurchasePricePoint | null;
 maximum: ItemPurchasePricePoint | null;
 latest: ItemPurchasePricePoint | null;
 latestAboveMinimumPercent: string | null;
}


/** Read-only, scoped composition peers; a shared composition does not authorize substitution. */
export interface ItemCompositionPeers {
 companyId: number;
 itemId: number;
 canViewStock: boolean;
 composition: {
   id: number;
   arabicName: string;
   englishName: string;
   active: boolean;
   identicalAlternative: boolean;
   nonInterchangeable: boolean;
 } | null;
 relation: "none" | "sameComposition" | "identicalAlternative" | "nonInterchangeable";
 total: number;
 page: number;
 pageSize: number;
 peers: Array<{
   id: number;
   code: string;
   name: string;
   active: boolean;
   smallestUnitName: string;
   stockSmallest: string | null;
 }>;
}
