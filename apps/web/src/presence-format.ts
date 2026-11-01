/** Relative last-activity / punch time with Arabic minutes, hours and days. */
export function sinceText(value: string | null, now = Date.now()): string {
  if (!value) return "لا يوجد سجل بعد";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "الآن";
  if (minutes < 60) return `منذ ${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;
  return `منذ ${Math.floor(hours / 24)} يوم`;
}
export function presenceDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-YE", {
    day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: "Asia/Aden",
  }).format(date);
}
