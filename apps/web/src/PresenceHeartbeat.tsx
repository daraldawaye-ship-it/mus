import { useEffect } from "react";
import { api, sessionRequiresLogin } from "./api";
import { isOfflineNow } from "./connection-mode";

/** A modest foreground signal, not a time clock or proof of physical presence.
 * No activity history, keystrokes, page URLs, or employee data are sent.\n * One compact heartbeat per five minutes at most while the user is active.
 */
export function PresenceHeartbeat({ userId }: { userId: number | null }) {
  useEffect(() => {
    if (!userId) return;
    let lastInteraction = Date.now();
    let lastSent = 0;
    let inflight = false;
    // One foreground ping per five minutes, including busy invoice editors.
    // Moving/clicking/typing does not itself create a database write.
    const intervalMs = 5 * 60_000;
    const interaction = () => {
      lastInteraction = Date.now();
      if (lastInteraction - lastSent >= intervalMs) void beat();
    };
    const beat = async () => {
      const now = Date.now();
      if (inflight || now - lastSent < intervalMs ||
          now - lastInteraction > 5 * 60_000 ||
          document.visibilityState !== "visible" || !navigator.onLine ||
          isOfflineNow() || sessionRequiresLogin()) return;
      inflight = true;
      lastSent = now;
      try {
        const notificationPermission = "Notification" in window
          ? Notification.permission : "unsupported";
        await api("/presence/heartbeat", { method: "POST", body: { notificationPermission } });
      }
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
    const interval = window.setInterval(() => { void beat(); }, 60_000);
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
