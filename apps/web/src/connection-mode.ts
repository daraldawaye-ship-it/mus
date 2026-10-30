/** One network state for invoices, lookups, sync and device notifications.
 * Manual mode is opt-in and never logs the user out or reloads a draft.
 */
export type ConnectionState = "online" | "manual-offline" | "browser-offline" | "network-unreachable";
const listeners = new Set<() => void>();
const available = () => typeof navigator === "undefined" || navigator.onLine;
let manualOffline = false;
let failedTransport = false;
let state: ConnectionState = available() ? "online" : "browser-offline";
const status = (): ConnectionState =>
  manualOffline ? "manual-offline" :
  !available() ? "browser-offline" :
  failedTransport ? "network-unreachable" : "online";
function notify() {
  const next = status();
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}
export function connectionSnapshot() { return state; }
export function subscribeConnection(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function isOfflineNow() { return status() !== "online"; }
export function isManualOffline() { return manualOffline; }
export function markNetworkFailure() {
  failedTransport = true;
  notify();
}
export function markNetworkSuccess() {
  failedTransport = false;
  notify();
}
function recovered() {
  if (!isOfflineNow() && typeof window !== "undefined")
    window.dispatchEvent(new Event("alraesy-network-restored"));
}
export async function checkConnection(): Promise<boolean> {
  if (manualOffline || !available()) {
    notify();
    return false;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/api/health", {
        cache: "no-store", credentials: "same-origin", signal: controller.signal,
      });
      if (!response.ok) throw new Error("health check failed");
    } finally {
      clearTimeout(timeout);
    }
    markNetworkSuccess();
    recovered();
    return true;
  } catch {
    markNetworkFailure();
    return false;
  }
}
export function setManualOffline(next: boolean) {
  manualOffline = next;
  notify();
  if (!next) void checkConnection();
}
if (typeof window !== "undefined") {
  window.addEventListener("offline", notify);
  window.addEventListener("online", () => { void checkConnection(); });
  window.addEventListener("focus", () => {
    if (!manualOffline && isOfflineNow()) void checkConnection();
  });
  // Some laptops keep Wi-Fi/LAN connected after the actual internet fails;
  // a failed API request marks the outage, and this probes for recovery.
  window.setInterval(() => {
    if (!manualOffline && isOfflineNow() && available() &&
        document.visibilityState !== "hidden") void checkConnection();
  }, 25000);
}
