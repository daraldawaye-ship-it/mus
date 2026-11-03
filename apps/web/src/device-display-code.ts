/** Public, stable company-device registry code. This is not a login token or hardware serial. */
export function formatKnownDeviceCode(id: string | number): string {
  const digits = String(id);
  if (!/^[1-9]\d*$/.test(digits)) return "";
  return "DEV-" + digits.padStart(6, "0");
}
