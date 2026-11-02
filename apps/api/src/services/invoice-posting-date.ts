/** Resolve a new invoice's posting date in Yemen's business calendar.
 * A locked-date user can never backdate, including with an overnight draft.
 * Accepted UUID replays keep the previously committed date unchanged.
 */
export function resolveInvoicePostingDate(
  requestedDate: string,
  serverToday: string,
  canEditDate: boolean,
  existingPostedDate: string | null,
): string {
  if (existingPostedDate !== null) return existingPostedDate;
  return canEditDate ? requestedDate : serverToday;
}
