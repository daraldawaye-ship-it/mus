/** Network state never resets the authenticated session or an unsaved draft.
 * Manual offline mode persists until the user explicitly returns online.
 */
export type ConnectionState = "online" | "manual-offline" | "browser-offline" | "network-unreachable";
const listeners = new Set<() => void>();
const available = () => typeof navigator === "undefined" || navigator.onLine;
let manualOffline = false;
let failedTransport = false;
const status = (): ConnectionState =>
  manualOffline ? "manual-offline" :
  !available() ? "browser-offline" :
  failedTransport ? "network-unreachable" : "online";
let snapshot = status();
function notify() {
  const next = status();
  if (snapshot === next) return;
  const previous = snapshot;
  snapshot = next;
  for (const listener of listeners) listener();
  if (previous !== "online" && next === "online" && typeof window !== "undefined") {
    window.dispatchEvent(new Event("alraesy-network-restored"));
  }
}
export function connectionSnapshot() { return snapshot; }
export function subscribeConnection(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function isOfflineNow() { return status() !== "online"; }
export function markNetworkFailure() { failedTransport = true; notify(); }
export function markNetworkSuccess() { failedTransport = false; notify(); }
export function setManualOffline() { manualOffline = true; notify(); }

/** Probe actual server access. Do not exit manual mode on a disconnected LAN. */
export async function returnToOnline(): Promise<boolean> {
  if (!available()) { notify(); return false; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("/api/health", {
      cache: "no-store", credentials: "same-origin", signal: controller.signal,
    });
    if (!response.ok) return false;
    manualOffline = false;
    failedTransport = false;
    notify();
    return true;
  } catch {
    if (!manualOffline) markNetworkFailure();
    return false;
  } finally { clearTimeout(timeout); }
}
if (typeof window !== "undefined") {
  window.addEventListener("offline", notify);
  window.addEventListener("online", () => {
    if (!manualOffline) void returnToOnline();
    else notify();
  });
  window.addEventListener("focus", () => {
    if (!manualOffline && isOfflineNow()) void returnToOnline();
  });
  // LAN or Wi-Fi can be connected while the server is unreachable.
  window.setInterval(() => {
    if (!manualOffline && isOfflineNow() && available() &&
        document.visibilityState !== "hidden") void returnToOnline();
  }, 25000);
}
