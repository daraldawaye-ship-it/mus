import { useEffect } from "react";
import { api, sessionRequiresLogin } from "./api";
import { isOfflineNow } from "./connection-mode";

/** A modest foreground signal, not a time clock or proof of physical presence.
 * No activity history, keystrokes, page URLs, or employee data are sent.
 */
export function PresenceHeartbeat({ userId }: { userId: number | null }) {
  useEffect(() => {
    if (!userId) return;
    let lastInteraction = Date.now();
    let lastSent = 0;
    let inflight = false;
    const interaction = () => { lastInteraction = Date.now(); };
    const beat = async () => {
      const now = Date.now();
      if (inflight || now - lastSent < 60_000 ||
          now - lastInteraction > 5 * 60_000 ||
          document.visibilityState !== "visible" || !navigator.onLine ||
          isOfflineNow() || sessionRequiresLogin()) return;
      inflight = true;
      lastSent = now;
      try { await api("/presence/heartbeat", { method: "POST", body: {} }); }
      catch { /* A presence hint must never impede a sale or offline drafts. */ }
      finally { inflight = false; }
    };
    const onResume = () => { interaction(); void beat(); };
    window.addEventListener("pointerdown", interaction, { passive: true });
    window.addEventListener("keydown", interaction);
    window.addEventListener("focus", onResume);
    window.addEventListener("online", onResume);
    document.addEventListener("visibilitychange", onResume);
    void beat();
    const interval = window.setInterval(() => { void beat(); }, 65_000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pointerdown", interaction);
      window.removeEventListener("keydown", interaction);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("online", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [userId]);
  return null;
}
