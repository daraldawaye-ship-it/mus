import type { PoolClient } from "pg";
import { HttpError } from "../errors.ts";
import { moneyString, moneyUnits } from "./finance.ts";

const SCALE = 1_000_000n;
type HistoricalLine = {
  itemId: number;
  unit: 1 | 2 | 3;
  quantity: string;
  unitPrice?: string;
  originalLineId: number | null;
};
type UnitFactors = { id: number; factor2: number; factor3: number; unit2_name: string; unit3_name: string };

/**
 * Import-only exact conversion: a fractional large unit may be posted as an
 * integer quantity of a genuine smaller unit, at the correspondingly reduced
 * price. Both quantity and gross value must be exactly conserved.
 *
 * Never round a fractional item or manufacture stock. Unrepresentable source
 * quantities must stay unposted pending native decimal-stock support.
 */
export function convertHistoricalFractionalLine<T extends HistoricalLine>(
  line: T, item: UnitFactors,
): T {
  if (!line.quantity.includes(".")) return line;
  if (!/^-?\d{1,22}\.\d{1,6}$/.test(line.quantity))
    throw new HttpError(409, "historical_quantity_precision",
      "الكمية التاريخية تتجاوز 6 منازل عشرية");
  const original = moneyUnits(line.quantity);
  if (original === 0n)
    throw new HttpError(409, "historical_zero_quantity", "الكمية التاريخية صفر");
  if (original % SCALE === 0n)
    return { ...line, quantity: (original / SCALE).toString() };
  if (line.originalLineId !== null || line.unitPrice === undefined)
    throw new HttpError(409, "historical_fractional_reference",
      "يتطلب ترحيل الكسر سعر مصدر صريحًا، ودون ربط بسطر مردود قديم");
  const price = moneyUnits(line.unitPrice);
  const factor2 = BigInt(item.factor2), factor3 = BigInt(item.factor3);
  const choices = line.unit === 1
    ? [{ unit: 2 as const, mult: factor2, name: item.unit2_name },
       { unit: 3 as const, mult: factor2 * factor3, name: item.unit3_name }]
    : line.unit === 2
      ? [{ unit: 3 as const, mult: factor3, name: item.unit3_name }]
      : [];
  for (const choice of choices) {
    if (choice.mult < 1n || !choice.name?.trim()) continue;
    const targetQuantity = original * choice.mult;
    if (targetQuantity % SCALE !== 0n || price % choice.mult !== 0n) continue;
    const convertedPrice = price / choice.mult;
    // Do not introduce new fractional YER prices into historical invoices.
    // The usual createInvoice() currency precision check is still mandatory.
    if (targetQuantity === 0n) continue;
    return {
      ...line,
      unit: choice.unit,
      quantity: (targetQuantity / SCALE).toString(),
      unitPrice: moneyString(convertedPrice),
    };
  }
  throw new HttpError(409, "historical_fractional_stock",
    "لا توجد وحدة أصغر تحقق كمية المصدر وسعرها بدقة؛ يتطلب الصنف دعم مخزون كسري");
}

export async function normalizeHistoricalInvoiceFractions<T extends HistoricalLine>(
  client: PoolClient, companyId: number, lines: T[],
): Promise<{ lines: T[]; converted: boolean }> {
  const fractional = lines.filter(line => line.quantity.includes("."));
  if (!fractional.length) return { lines, converted: false };
  const ids = [...new Set(fractional.map(line => line.itemId))];
  const found = await client.query<UnitFactors>(
    "SELECT id,factor2,factor3,unit2_name,unit3_name FROM items WHERE company_id=$1 AND id=ANY($2::integer[])",
    [companyId, ids],
  );
  const byId = new Map(found.rows.map(row => [row.id, row]));
  const transformed = lines.map(line => {
    if (!line.quantity.includes(".")) return line;
    const item = byId.get(line.itemId);
    if (!item)
      throw new HttpError(409, "historical_missing_item",
        "لا يمكن تحويل كمية كسرية لصنف غير موجود في الشركة");
    return convertHistoricalFractionalLine(line, item);
  });
  return { lines: transformed, converted: transformed.some((line, i) =>
    line.quantity !== lines[i]!.quantity || line.unit !== lines[i]!.unit) };
}
