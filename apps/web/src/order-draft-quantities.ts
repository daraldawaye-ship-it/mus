export const formatNumber = (value?: string | null) => {
  if (value == null || value === "") return "—";
  const [whole, decimals = ""] = value.split(".");
  const fraction = decimals.replace(/0+$/, "");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? "." + fraction : "");
};

/** One decimal place in the display only, leaving precise item data unchanged.
 * Preserve the distinction between zero and a tiny nonzero fractional quantity. */
export const formatStockSaleQuantity = (value?: string | null) => {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return formatNumber(value);
  if (Number.isInteger(number)) return formatNumber(value);
  const rounded = Math.round((Math.abs(number) + Number.EPSILON) * 10) / 10;
  if (rounded === 0) return number < 0 ? ">−0.1" : "<0.1";
  const fixed = (number < 0 ? -rounded : rounded).toFixed(1);
  const [whole, digit] = fixed.split(".");
  return formatNumber(whole) + "." + digit;
};

