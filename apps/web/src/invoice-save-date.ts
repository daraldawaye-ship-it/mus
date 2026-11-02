/** Invoice transaction dates use Yemen's business calendar, not the browser timezone.
 * A purchase/sale draft may have remained open across midnight.
 */
export function adenInvoiceToday(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Aden",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const read = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

/** Only an explicit date edit by a user with permission preserves another date.
 * Ordinary sales and purchase forms always post on their actual save day.
 */
export function invoiceDateAtSave(
  formDate: string,
  dateEditedWithPermission: boolean,
  at: Date = new Date(),
): string {
  return dateEditedWithPermission && /^\d{4}-\d{2}-\d{2}$/.test(formDate)
    ? formDate
    : adenInvoiceToday(at);
}
