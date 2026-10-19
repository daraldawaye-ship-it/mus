import type { InvoiceKind } from "../../../packages/contracts/src/commerce";

/** Sales use the employee's cashbox; purchases use only an explicitly configured control account. */
export function initialInvoiceAccount<T>(
  kind: InvoiceKind,
  employeeCashbox: T | null,
  configuredPurchaseAccount: T | null = null,
): T | null {
  return kind === "sale" ? employeeCashbox : configuredPurchaseAccount;
}
