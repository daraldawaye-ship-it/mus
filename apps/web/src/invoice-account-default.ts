import type { InvoiceKind } from "../../../packages/contracts/src/commerce";

/** Never preselect a cashbox for purchases; sales retain the employee default. */
export function initialInvoiceAccount<T>(
  kind: InvoiceKind,
  employeeCashbox: T | null,
): T | null {
  return kind === "sale" ? employeeCashbox : null;
}
