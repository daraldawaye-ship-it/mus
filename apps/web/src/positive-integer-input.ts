import { normalizeDigits } from "../../../packages/contracts/src/index.ts";

/** Keep order quantity and purchase unit factor at one or above during input,
 * not just after submitting the card. Arabic digits are supported. */
export function positiveIntegerInput(
  raw: string, previous: string, max: bigint,
): string {
  const normalized = normalizeDigits(raw.trim());
  if (normalized === "") return "1";
  if (!/^\d+$/.test(normalized)) return previous;
  const digits = normalized.replace(/^0+/, "") || "0";
  if (digits === "0") return "1";
  if (digits.length > 22) return previous;
  const value = BigInt(digits);
  return value <= max ? value.toString() : previous;
}
