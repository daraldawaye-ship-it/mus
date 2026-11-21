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

/** Workboard presentation only. Preserve the true direction even when it rounds to zero. */
export function formatWorkPanelMovementQuantity(raw: string): {
  text: string; direction?: "positive" | "negative";
} {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return { text: raw };
  const [, sign, whole = "0", fractional = ""] = match;
  const hasFraction = /[1-9]/.test(fractional);
  if (!hasFraction && !/[1-9]/.test(whole)) return { text: "0" };
  const direction = sign === "-" ? "negative" : "positive";
  const prefix = direction === "negative" ? "−" : "+";
  if (!hasFraction) return { text: prefix + whole, direction };
  const tenths = BigInt(whole) * 10n + BigInt(fractional[0] ?? "0") +
    ((fractional[1] ?? "0") >= "5" ? 1n : 0n);
  return { text: `${prefix}${tenths / 10n}.${tenths % 10n}`, direction };
}
