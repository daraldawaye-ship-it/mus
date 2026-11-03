/** Signed ledger quantities always use the item's smallest unit. Never round. */
export function signedStockMovementQuantity(quantitySmallest: string): string {
  if (!/^-?\d+$/.test(quantitySmallest)) return quantitySmallest;
  if (quantitySmallest.startsWith("-") || quantitySmallest === "0") return quantitySmallest;
  return "+" + quantitySmallest;
}
