import { useEffect } from "react";
import { api, sessionRequiresLogin } from "./api";
import { isOfflineNow } from "./connection-mode";

const KEY = "alraesy-browser-installation-v1";
// Identifies one origin/browser storage installation, NOT a secure hardware ID.
// A browser reset, private window or independent PWA data store may be a new entry.
export function browserInstallationId(): string | null {
  if (typeof window === "undefined" || !globalThis.crypto?.randomUUID) return null;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) return stored;
    const created = crypto.randomUUID();
    localStorage.setItem(KEY, created);
    return created;
  } catch {
    return null;
  }
}

/** Company-scoped, best-effort identification. Never blocks loading or saving. */
export function CompanyDeviceDiscovery({ userId, companyId }: { userId: number; companyId: number }) {
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let lastSent = 0;
    let activityInFlight = false;
    let lastActivitySent = 0;
    const requests = new AbortController();
    const intervalMs = 5 * 60_000;
    const canSend = () => active && navigator.onLine && document.visibilityState === "visible" &&
      !isOfflineNow() && !sessionRequiresLogin();
    const discover = async () => {
      if (!canSend() || inFlight || Date.now() - lastSent < intervalMs) return;
      const deviceId = browserInstallationId();
      if (!deviceId) return;
      inFlight = true;
      lastSent = Date.now();
      try {
        await api("/companies/" + companyId + "/approved-devices/discover", {
          method: "POST", body: { deviceId }, signal: requests.signal,
        });
      } catch {
        // Retry after the next interval, on focus or when connectivity resumes.
        lastSent = 0;
      } finally {
        inFlight = false;
      }
    };
    const onActivity = async (event: Event) => {
      if (!event.isTrusted || !canSend() || activityInFlight || Date.now() - lastActivitySent < intervalMs)
        return;
      // Mobile installs only need regular recognition. Desktop-mode iPad
      // sends a Mac-like UA, but still reports its touch capability.
      const ua = navigator.userAgent;
      if (/Android|iPhone|iPad|iPod|Mobile|Mobi/i.test(ua) ||
          (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return;
      const deviceId = browserInstallationId();
      if (!deviceId) return;
      activityInFlight = true;
      lastActivitySent = Date.now();
      try {
        await api("/companies/" + companyId + "/approved-devices/discover", {
          method: "POST", body: { deviceId, activeInteraction: true }, signal: requests.signal,
        });
      } catch {
        lastActivitySent = 0;
      } finally {
        activityInFlight = false;
      }
    };
    const activityEvents = ["pointerdown", "keydown", "wheel"] as const;
    for (const type of activityEvents)
      window.addEventListener(type, onActivity, { capture: true, passive: true });
    const resume = () => { void discover(); };
    void discover();
    const timer = window.setInterval(resume, intervalMs);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      requests.abort();
      for (const type of activityEvents) window.removeEventListener(type, onActivity, true);
      window.clearInterval(timer);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [userId, companyId]);
  return null;
}
