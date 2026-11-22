import { z } from "zod";

export const tableColumnDefaultIds = ["item-options-list", "journal-lines"] as const;
export type TableColumnDefaultId = (typeof tableColumnDefaultIds)[number];
type Definition = { id: string; label: string; width: number; visible: boolean };
const definitions = {
  "item-options-list": { pageKey: "company.item-options-list", label: "قائمة الأصناف", columns: [
    {"id":"choice","label":"اختيار","width":48,"visible":true},
    {"id":"stock","label":"المتوفر دون المرتجعات (الوحدة الأولى)","width":65,"visible":true},
    {"id":"saleQuantityMonth","label":"الكمية المباعة في شهر (الوحدة الأولى)","width":77,"visible":true},
    {"id":"name","label":"اسم الصنف","width":185,"visible":true},
    {"id":"reserve","label":"كمية احتياط","width":116,"visible":false},
    {"id":"purchaseFactor","label":"عامل وحدة الشراء (الوحدة الأولى)","width":116,"visible":false},
    {"id":"minOrderQuantity","label":"أقل كمية طلب","width":140,"visible":false},
    {"id":"orderAlertQuantity","label":"كمية الطلب","width":140,"visible":false},
    {"id":"orderStoppedUntil","label":"إيقاف","width":405,"visible":false},
    {"id":"reviewed","label":"مراجع","width":140,"visible":false},
    {"id":"month","label":"مبيعات مرات في شهر","width":67,"visible":true},
    {"id":"marketOrder30Days","label":"مرات الطلب من السوق آخر 30 يوم","width":67,"visible":true},
    {"id":"marketOrderAfterPurchase30Days","label":"مرات الطلب من السوق آخر 30 يوم بعد آخر شراء","width":67,"visible":true},
    {"id":"fourMonths","label":"مبيعات مرات في 4 أشهر","width":67,"visible":true},
    {"id":"allTime","label":"مبيعات مرات منذ البداية","width":70,"visible":true},
    {"id":"previousYear","label":"مرات عام السابق","width":70,"visible":true},
    {"id":"requiredPurchaseQuantity","label":"الكمية المطلوبة (الوحدة الأولى)","width":83,"visible":true},
    {"id":"purchasePrice","label":"سعر الشراء الافتراضي (الوحدة الأولى)","width":84,"visible":true},
    {"id":"requiredPurchaseValue","label":"قيمة المطلوب","width":90,"visible":true},
    {"id":"purchaseNotes","label":"ملاحظات عند الشراء","width":210,"visible":true},
    {"id":"coverage","label":"الكفاية بدون الاحتياط (يوم)","width":65,"visible":true},
    {"id":"coverageWithReserve","label":"الكفاية مع الاحتياط (يوم)","width":65,"visible":true},
    {"id":"coverageWithRequired","label":"الكفاية مع المطلوب (يوم)","width":68,"visible":true},
    {"id":"reserveCoverage","label":"كفاية كمية الاحتياط وحدها (يوم)","width":72,"visible":true},
    {"id":"purchaseFactorCoverage","label":"كفاية عامل وحدة الشراء (يوم)","width":75,"visible":true},
    {"id":"compositionSaleMonth","label":"كمية التركيب المباعة في شهر (الوحدة الأولى)","width":77,"visible":true},
    {"id":"compositionStock","label":"الكمية المتوفرة للتركيب (الوحدة الأولى)","width":65,"visible":true},
    {"id":"compositionCoverage","label":"الكفاية التقريبية للتركيب (يوم)","width":65,"visible":true},
    {"id":"adjustmentQtySinceDisplay","label":"صافي كمية العجز والزيادة منذ آخر عرض","width":92,"visible":false},
    {"id":"adjustmentValueSinceDisplay","label":"صافي قيمة العجز والزيادة منذ آخر عرض","width":105,"visible":false},
    {"id":"adjustmentQtySinceApproval","label":"صافي كمية العجز والزيادة منذ آخر اعتماد","width":92,"visible":false},
    {"id":"adjustmentValueSinceApproval","label":"صافي قيمة العجز والزيادة منذ آخر اعتماد","width":105,"visible":false},
  ] },
  "journal-lines": { pageKey: "company.journal-lines", label: "القيود بالسطور", columns: [
    {"id":"number","label":"رقم القيد","width":145,"visible":true},
    {"id":"documentDate","label":"التاريخ المكتوب","width":135,"visible":true},
    {"id":"accountName","label":"اسم الحساب","width":245,"visible":true},
    {"id":"postedAt","label":"الترحيل الفعلي (عدن)","width":190,"visible":true},
    {"id":"documentDescription","label":"بيان القيد","width":270,"visible":true},
    {"id":"accountCode","label":"كود الحساب","width":130,"visible":true},
    {"id":"debit","label":"مدين","width":115,"visible":true},
    {"id":"credit","label":"دائن","width":115,"visible":true},
    {"id":"currency","label":"العملة","width":85,"visible":true},
    {"id":"description","label":"بيان السطر","width":270,"visible":true},
    {"id":"lineNumber","label":"السطر","width":70,"visible":true},
    {"id":"status","label":"الحالة","width":95,"visible":true},
    {"id":"document","label":"الأصل","width":120,"visible":true},
  ] },
} as const satisfies Record<TableColumnDefaultId, {pageKey: string; label: string; columns: readonly Definition[]}>;

export const tableColumnDefaultsCatalog = {
  "item-options-list": { ...definitions["item-options-list"], columnIds: definitions["item-options-list"].columns.map(c=>c.id) },
  "journal-lines": { ...definitions["journal-lines"], columnIds: definitions["journal-lines"].columns.map(c=>c.id) },
} as const;

export const tableColumnDefaultSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  width: z.number().int().min(48).max(640),
  visible: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
}).strict();

const columns = z.array(tableColumnDefaultSchema).max(64)
  .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, "العمود مكرر");
const revision = z.number().int().min(0).max(2147483647);
export const tableColumnDefaultsInputSchema = z.object({ expectedRevision: revision.max(2147483646), columns }).strict();
export const tableColumnDefaultsResponseSchema = z.object({ revision, columns }).strict();
export type TableColumnDefault = z.infer<typeof tableColumnDefaultSchema>;
export type TableColumnDefaults = z.infer<typeof tableColumnDefaultsResponseSchema>;

/** Never include configuration for columns not actually available in this table. */
export function usableColumnDefaults<Key extends string>(
  allowed: readonly Key[], rows: readonly TableColumnDefault[],
): Array<TableColumnDefault & { id: Key }> {
  const byId = new Set<string>(allowed);
  const seen = new Set<string>();
  return rows.filter((r): r is TableColumnDefault & {id: Key} => {
    if (!byId.has(r.id) || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}
