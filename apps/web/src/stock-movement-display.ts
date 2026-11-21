import type { StockMovement, StockMovementKind } from "../../../packages/contracts/src/inventory.ts";

export const workPanelMovementKindLabels: Record<StockMovementKind, string> = {
  sale: "مبيع",
  purchase: "شراء",
  sales_return: "مرتجع مبيع",
  purchase_return: "مرتجع شراء",
  transfer_in: "مناقلة",
  transfer_out: "مناقلة",
  adjustment_surplus: "تسوية",
  adjustment_shortage: "تسوية",
  unit_rebase: "تحويل الوحدة",
  reversal: "عكس حركة",
};

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
