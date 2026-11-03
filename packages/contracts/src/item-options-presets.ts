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
  monthMin: numericRange,
  monthMax: numericRange,
  fourMonthsMin: numericRange,
  fourMonthsMax: numericRange,
  allTimeMin: numericRange,
  allTimeMax: numericRange,
  coverageMin: numericRange,
  coverageMax: numericRange,
  excludeZero: z.boolean(),
  useReserve: z.boolean(),
  sortBy: z.enum(["code", "name", "stock", "month", "fourMonths", "allTime", "coverage"]),
  sortDir: z.enum(["asc", "desc"]),
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
