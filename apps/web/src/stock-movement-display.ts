import type { StockMovement, StockMovementKind } from "../../../packages/contracts/src/inventory.ts";

export const workPanelMovementKindLabels: Record<StockMovementKind, string> = {
  sale: "مبيع",
  purchase: "شراء",
  sales_return: "مرتجع مبيع",
  purchase_return: "مرتجع شراء",
  transfer_in: "مناقلة",
  transfer_out: "مناقلة",
  adjustment_surplus: "تسوية زيادة",
  adjustment_shortage: "تسوية نقص",
  unit_rebase: "تحويل الوحدة",
  reversal: "عكس حركة",
};

export function isStockAdjustment(kind:StockMovementKind):boolean {
  return kind==="adjustment_surplus"||kind==="adjustment_shortage";
}
export function stockMovementOperationReference(row:Pick<StockMovement,"kind"|"operationId">):string|null {
  if(row.operationId==null)return null;
  return (isStockAdjustment(row.kind)?"تسوية رقم ":"عملية ")+row.operationId;
}
export function workPanelStockMovementQuantity(kind:StockMovementKind,raw:string,firstUnitMultiplier?:string|null) {
  // A settlement has no invoice pack-size snapshot. Show the exact posted delta
  // explicitly in its smallest unit instead of implying a conversion.
  return formatWorkPanelMovementQuantity(raw,isStockAdjustment(kind)?"1":firstUnitMultiplier);
}

export function workPanelPurchaseSupplier(row: Pick<StockMovement,
  "kind" | "invoiceId" | "originalMovementId" | "supplierAccountName" | "supplierInferenceSource">): string | null {
  if (row.kind !== "purchase" || row.invoiceId == null || row.originalMovementId != null ||
      row.supplierInferenceSource !== null) return null;
  return row.supplierAccountName?.trim() || null;
}

/** Signed ledger quantities always use the item's smallest unit. Never round. */
export function signedStockMovementQuantity(quantitySmallest: string): string {
  if (!/^-?\d+$/.test(quantitySmallest)) return quantitySmallest;
  if (quantitySmallest.startsWith("-") || quantitySmallest === "0") return quantitySmallest;
  return "+" + quantitySmallest;
}

/** Convert the exact signed stock delta using the source invoice line's recorded pack size. */
export function formatWorkPanelMovementQuantity(raw: string, firstUnitMultiplier?: string | null): {
  text: string; direction?: "positive" | "negative"; exact?: string;
} {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match || !firstUnitMultiplier || !/^\d+$/.test(firstUnitMultiplier)) return { text: "—" };
  const [, sign, whole = "0", fractional = ""] = match;
  const stockUnits = BigInt(whole + fractional);
  const divisor = BigInt(firstUnitMultiplier) * 10n ** BigInt(fractional.length);
  if (divisor === 0n) return { text: "—" };
  const exact = BigInt(firstUnitMultiplier) === 1n ? raw : `${raw} ÷ ${firstUnitMultiplier}`;
  if (stockUnits === 0n) return { text: "0", exact };
  const direction = sign === "-" ? "negative" : "positive";
  const prefix = direction === "negative" ? "−" : "+";
  if (stockUnits % divisor === 0n) return { text: prefix + stockUnits / divisor, direction, exact };
  const tenths = (stockUnits * 20n + divisor) / (divisor * 2n);
  return { text: `${prefix}${tenths / 10n}.${tenths % 10n}`, direction, exact };
}

/** Adjustment row text only: round the decimal string to at most one place.
 * Keep the source value and its sign/visual direction outside this formatter. */
export function formatWorkPanelOperationQuantity(raw: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return raw;
  const [,sign,whole,fraction=""] = match;
  const tenths = BigInt(whole!) * 10n + BigInt(fraction[0] ?? "0") +
    ((fraction[1] ?? "0") >= "5" ? 1n : 0n);
  const decimal = tenths % 10n;
  return sign + (tenths / 10n).toString() + (decimal ? `.${decimal}` : "");
}
