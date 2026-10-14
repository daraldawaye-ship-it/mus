/**
 * Display exact decimal amounts with ASCII thousands separators.
 * Never coerce monetary strings through Number/parseFloat: invoices may
 * contain up to 22 integral digits and six fractional digits.
 * IDs, barcodes, quantities and dates are intentionally not auto-formatted.
 */
export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const text = String(value);
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(text);
  if (!match) return text;
  return `${match[1]}${match[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${match[3] ?? ""}`;
}
