import type { Item } from "../../../packages/contracts/src/items.ts";

/** Display location stock in the selected sale unit without unsafe floating-point conversion. */
export function saleStockQuantity(
  smallest: string,
  item: Pick<Item, "factor2" | "factor3">,
  unit: 1 | 2 | 3,
  displayDecimals: 1 | 4 = 4,
): string {
  const factor = unit === 1 ? BigInt(item.factor2) * BigInt(item.factor3) : unit === 2 ? BigInt(item.factor3) : 1n;
  // The one-decimal view is presentation-only; it must not affect stored stock,
  // invoice quantities or amounts. BigInt avoids float rounding for large stock.
  if (displayDecimals === 1) {
    const value = BigInt(smallest);
    const absolute = value < 0n ? -value : value;
    const tenths = (absolute * 20n + factor) / (2n * factor);
    const whole = tenths / 10n;
    const digit = tenths % 10n;
    const sign = value < 0n && tenths !== 0n ? "-" : "";
    return sign + whole.toString() + (digit ? "." + digit.toString() : "");
  }
  const value = BigInt(smallest);
  const absolute = value < 0n ? -value : value;
  const whole = absolute / factor;
  const remainder = absolute % factor;
  const sign = value < 0n ? "-" : "";
  if (!remainder) return sign + whole.toString();
  const digits = (remainder * 10000n / factor).toString().padStart(4, "0").replace(/0+$/, "");
  const approximate = remainder * 10000n % factor !== 0n;
  return (approximate ? "≈" : "") + sign + whole.toString() + (digits ? "." + digits : "");
}

/** Present the exact combined smallest-unit stock as first-unit quantity, rounded to three decimals. */
export function firstUnitStockText(
  smallest: string | null | undefined,
  item: Pick<Item, "factor2" | "factor3">,
): string {
  if (smallest === null || smallest === undefined) return "—";
  const value = BigInt(smallest);
  const denominator = BigInt(item.factor2) * BigInt(item.factor3);
  const absolute = value < 0n ? -value : value;
  const thousandths = (absolute * 1000n * 2n + denominator) / (2n * denominator);
  const integer = thousandths / 1000n;
  const fraction = (thousandths % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return (value < 0n && thousandths !== 0n ? "-" : "") + integer.toString()
    + (fraction ? "." + fraction : "");
}

/** Compact invoice search presentation: exactly one decimal in first-unit stock. */
export function invoiceSearchStock(
  item: Pick<Item, "availableSmallest" | "factor2" | "factor3">,
): string {
  if (item.availableSmallest == null) return "—";
  const value = saleStockQuantity(item.availableSmallest, item, 1, 1);
  return value.includes(".") ? value : value + ".0";
}
