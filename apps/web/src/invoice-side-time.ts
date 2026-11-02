/** Invoice sidebar event-time presentation, with a fixed Sanaa/Yemen clock
 * (Asia/Aden). The event's relative age is computed from current time, never
 * from last cashbox closure or from a cached server timestamp.
 */
export function invoiceSideElapsed(timestamp: string, nowMs = Date.now()): string {
  const dateMs = Date.parse(timestamp);
  if (!Number.isFinite(dateMs)) return "—";
  const ageMinutes = Math.max(0, Math.floor((nowMs - dateMs) / 60_000));
  if (ageMinutes === 0) return "الآن";
  const hours = Math.floor(ageMinutes / 60);
  const minutes = ageMinutes % 60;
  return hours === 0 ? `منذ ${minutes} دقيقة`
    : `منذ ${hours} ساعة و${minutes} دقيقة`;
}

export function invoiceSideDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  const dateParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Aden", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(date);
  const part = (name: string) => dateParts.find(entry => entry.type === name)?.value ?? "";
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Aden", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(date);
  const timePart = (name: string) => timeParts.find(entry => entry.type === name)?.value ?? "";
  const marker = timePart("dayPeriod").toUpperCase() === "PM" ? "م" : "ص";
  return `${part("day")}/${part("month")}/${part("year")} ${timePart("hour")}:${timePart("minute")} ${marker}`;
}
