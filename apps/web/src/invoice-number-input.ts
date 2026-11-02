import { normalizeDigits } from "../../../packages/contracts/src/masters.ts";

/** Return null to reject the keystroke/paste entirely (letters, symbols,
 * excess precision or oversized numbers). Numeric fields never become blank.
 * Quantity -1 remains a valid merchandise return, while 0 is not a quantity.
 */
export function enteredInvoiceQuantity(value: string): string | null {
  const text = normalizeDigits(value.trim());
  if (text === "") return "1";
  if (text === "-") return "-"; // Keep the sign while the user types the negative quantity.
  if (!/^-?\d{1,22}$/.test(text)) return null;
  const negative = text.startsWith("-");
  const magnitude = (negative ? text.slice(1) : text).replace(/^0+(?=\d)/, "");
  if (BigInt(magnitude) === 0n) return negative ? "-0" : "1";
  return (negative ? "-" : "") + magnitude;
}

/** Finish a partially typed negative quantity before leaving the field.
 * Neither a zero nor a sign alone can be submitted as an invoice quantity.
 */
export function completedInvoiceQuantity(value: string): string {
  const entered = enteredInvoiceQuantity(value);
  if (entered === "-" || entered === "-0") return "-1";
  return entered ?? "1";
}

/** Invoice line quantity is stored as an exact integer. When the cell is idle,
 * display one decimal digit without changing inventory/accounting payloads.
 * Do not format while the cashier is typing or during a partial negative sign.
 */
export function displayInvoiceQuantity(value: string): string {
  return /^-?\\d+$/.test(value) && value !== "-0" ? `${value}.0` : value;
}

/** Header discount is 0 when cleared. A single '-' becomes '-0' so users
 * can type a negative number without ever storing an empty or invalid field.
 * The trailing '.' is transient while typing six-decimal monetary amounts;
 * finishing the field converts it to a valid numeric representation.
 */
export function enteredInvoiceDiscount(value: string): string | null {
  const text = normalizeDigits(value.trim()).replace(/٫/g, ".");
  if (text === "") return "0";
  if (text === "-") return "-0";
  if (!/^-?\d{1,22}(?:\.\d{0,6})?$/.test(text)) return null;
  return text.replace(/^(-?)0+(?=\d)/, "$1");
}
export function completedInvoiceDiscount(value: string): string {
  return (enteredInvoiceDiscount(value) ?? "0").replace(/\.$/, "").replace(/^-0$/, "0");
}
