import { z } from "zod";

// Saved list filters are company-shared. Preserve explicit blank ranges (no limit)
// instead of restoring the stock 1-to-1 default when a preset is reopened.
const numericRange = z.string().regex(
  /^(?:|-?\d{1,15}(?:\.\d{1,6})?)$/,
  "أدخل عددًا صالحًا حتى 6 منازل عشرية، أو اترك الحقل فارغًا",
);
export const itemOptionsPresetFiltersSchema = z.object({
  q: z.string().trim().max(120),
  active: z.enum(["active", "archived", "all"]),
  stockMin: numericRange,
  stockMax: numericRange,
  reserveMin: numericRange.default(""),
  reserveMax: numericRange.default(""),
  purchaseFactorMin: numericRange.default(""),
  purchaseFactorMax: numericRange.default(""),
  purchasePriceMin: numericRange.default(""),
  purchasePriceMax: numericRange.default(""),
  requiredPurchaseQuantityMin: numericRange.default(""),
  requiredPurchaseQuantityMax: numericRange.default(""),
  requiredPurchaseValueMin: numericRange.default(""),
  requiredPurchaseValueMax: numericRange.default(""),
  monthMin: numericRange,
  monthMax: numericRange,
  fourMonthsMin: numericRange,
  fourMonthsMax: numericRange,
  // Old saved filters had no rolling-year condition; keep their matched set.
  yearMin: numericRange.default(""),
  yearMax: numericRange.default(""),
  allTimeMin: numericRange,
  allTimeMax: numericRange,
  previousYearMin: numericRange.default(""),
  previousYearMax: numericRange.default(""),
  coverageMin: numericRange,
  coverageMax: numericRange,
  coverageWithReserveMin: numericRange.default(""),
  coverageWithReserveMax: numericRange.default(""),
  coverageWithRequiredMin: numericRange.default(""),
  coverageWithRequiredMax: numericRange.default(""),
  // Old shared filters automatically acquire the independent 1-day target.
  orderTargetDays: z.string().regex(/^\d{1,15}(?:\.\d{1,6})?$/)
    .refine(value => Number(value) > 0, "حدّد أيامًا أكبر من صفر").default("1"),
  reserveCoverageMin: numericRange.default(""),
  reserveCoverageMax: numericRange.default(""),
  purchaseFactorCoverageMin: numericRange.default(""),
  purchaseFactorCoverageMax: numericRange.default(""),
  excludeZero: z.boolean(),
  // Old saved presets without this field must keep the new safe default.
  excludeOrderStopped: z.boolean().default(true),
  // Drafts are stored on the current device; older presets default to excluding them.
  excludeOrderDrafts: z.boolean().default(true),
  // Older saved filter sets may still carry the removed reserve switch.
  // It is accepted for decoding only and is ignored in new computations.
  useReserve: z.boolean().optional(),
  coverageFilterVersion: z.literal(2).optional(),
  sortBy: z.enum(["code", "name", "stock", "reserve", "purchaseFactor", "month", "saleQuantityMonth", "fourMonths", "year", "allTime", "previousYear", "coverage", "coverageWithReserve", "reserveCoverage", "purchaseFactorCoverage", "purchasePrice", "requiredPurchaseQuantity", "requiredPurchaseValue", "coverageWithRequired"]),
  sortDir: z.enum(["asc", "desc"]),
  // Optional for backwards compatibility with presets saved before column preferences existed.
  // Shared presets preserve exactly which columns the user chose on any device.
  coverageColumnsVersion: z.literal(2).optional(),
  visibleColumns: z.array(z.enum([
    "choice", "name", "purchaseNotes", "stock", "reserve", "purchaseFactor", "month",
    "saleQuantityMonth", "fourMonths", "allTime", "previousYear",
    "requiredPurchaseQuantity", "purchasePrice", "requiredPurchaseValue",
    "coverage", "coverageWithReserve", "coverageWithRequired", "reserveCoverage", "purchaseFactorCoverage",
    ])).min(1).max(19).refine(columns => new Set(columns).size === columns.length,
    "لا يمكن تكرار العمود في مجموعة الحفظ").optional(),
}).strict();
export const itemOptionsPresetCreateSchema = z.object({
  name: z.string().trim().min(1, "اكتب اسمًا للفلتر").max(80),
  filters: itemOptionsPresetFiltersSchema,
}).strict();
export type ItemOptionsPresetFilters = z.infer<typeof itemOptionsPresetFiltersSchema>;
export interface ItemOptionsPreset {
  id: number;
  name: string;
  filters: ItemOptionsPresetFilters;
  createdBy: number;
  createdByName: string;
  createdAt: string;
}

/** A reusable ordered sequence of existing named filters, shared by company. */
export const itemOptionsPresetGroupCreateSchema = z.object({
  name: z.string().trim().min(1,"اكتب اسمًا لتجميع الخيارات").max(80),
  presetIds: z.array(z.number().int().positive()).min(1).max(20)
    .refine(ids => new Set(ids).size===ids.length, "لا تكرر الخيار داخل التجميع"),
}).strict();
export interface ItemOptionsPresetGroup {
  id: number;
  name: string;
  presetIds: number[];
  createdBy: number;
  createdByName: string;
  createdAt: string;
}
