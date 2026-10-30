import { HttpError } from "../errors.ts";

/**
 * Dar Al-Dawa legacy item movements are signed as stock deltas:
 * sale < 0 means sold OUT, sale > 0 means customer return IN.
 * Commerce invoice quantities use the opposite sign for sales.
 *
 * Apply this ONLY to new, unmapped legacy sales. Keep the original
 * request and provenance intact so idempotency hashes never change.
 */
export function legacySaleInvoiceLines<T extends { quantity: string }>(
  companyId: number,
  sourceSystem: string,
  kind: "sale" | "purchase",
  lines: T[],
  sourceRows: Record<string, string>[],
): T[] {
  if (
    companyId !== 2 ||
    sourceSystem !== "dar-aldawa-legacy-2026-10" ||
    kind !== "sale"
  ) return lines;

  // Fail closed rather than silently reversing a request that has already
  // been converted on the client or is missing original source movements.
  if (lines.length !== sourceRows.length)
    throw new HttpError(409, "legacy_sale_source_mismatch",
      "عدد سطور فاتورة المبيعات لا يطابق حركات المصدر القديم");

  return lines.map((line, index) => {
    const row = sourceRows[index]!;
    const original = row["الكمية_المحسوبة_اخيرا"]?.trim();
    const quantity = line.quantity.trim();
    const numeric = /^-?\d+(?:\.\d+)?$/;
    const zero = /^-?0+(?:\.0+)?$/;
    if (
      row["نوع_العمليه"]?.trim() !== "فاتورة مبيعات" ||
      !original || !numeric.test(original) || zero.test(original) ||
      !numeric.test(quantity) || zero.test(quantity) ||
      original.startsWith("-") !== quantity.startsWith("-")
    )
      throw new HttpError(409, "legacy_sale_sign_mismatch",
        "إشارة أو نوع حركة المبيعات لا يطابق المصدر؛ لا تُرحّل الفاتورة قبل المطابقة");

    return {
      ...line,
      quantity: quantity.startsWith("-") ? quantity.slice(1) : `-${quantity}`,
    };
  });
}
