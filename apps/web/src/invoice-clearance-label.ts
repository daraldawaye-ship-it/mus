/**
 * Show clearance in the sales item picker only when the dated campaign is
 * active on this invoice date.  A rate without both dates is not active.
 * This is presentation only: the posted commission is computed by the API.
 */
export function saleClearanceRate(
  item: {
    active: boolean;
    commissionRate: string;
    clearanceFrom: string | null;
    clearanceTo: string | null;
  },
  documentDate: string,
): string | null {
  if (!item.active || !item.clearanceFrom || !item.clearanceTo ||
      !/^\d{4}-\d{2}-\d{2}$/.test(documentDate) ||
      documentDate < item.clearanceFrom || documentDate > item.clearanceTo)
    return null;
  const rate = Number(item.commissionRate);
  return Number.isFinite(rate) && rate > 0 && rate <= 100
    ? String(rate)
    : null;
}
