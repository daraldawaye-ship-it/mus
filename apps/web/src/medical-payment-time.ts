// The report API already provides Aden local time as HH:mm. This only changes
// how that known time is written, without applying the device time zone again.
export function medicalPaymentTimeLabel(time: string | null) {
  if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const hour = Number(time.slice(0, 2));
  return {
    clock: `${hour % 12 || 12}:${time.slice(3)}`,
    period: hour < 12 ? "صباحًا" : "مساءً",
  };
}
