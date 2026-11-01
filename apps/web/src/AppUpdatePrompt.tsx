import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { refreshEntireApp } from "./app-force-refresh";
import { isOfflineNow } from "./connection-mode";
import { appShellBuildFingerprint } from "./app-update-version";

// Capture the entry build before React mounts and lazy route CSS arrives.
const loadedShell = typeof document === "undefined"
  ? null : appShellBuildFingerprint(document.head.innerHTML);

/** Watch the static HTML, never querying the database or the logged-in user. */
export function AppUpdatePrompt() {
  const [available, setAvailable] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loadedShell) return;
    let disposed = false;
    let checking = false;
    const check = async () => {
      if (checking || disposed || isOfflineNow() || document.visibilityState === "hidden") return;
      checking = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 9000);
      try {
        const response = await fetch("/?alraesy-update-check=" + Date.now(), {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "text/html" },
          signal: controller.signal,
        });
        if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return;
        const deployed = appShellBuildFingerprint(await response.text());
        if (!disposed && deployed && deployed !== loadedShell) setAvailable(deployed);
      } catch {
        // An offline device or deployment outage must never interrupt a form.
      } finally {
        window.clearTimeout(timeout);
        checking = false;
      }
    };
    const first = window.setTimeout(() => { void check(); }, 6000);
    const periodic = window.setInterval(() => { void check(); }, 120_000);
    const onResume = () => { void check(); };
    window.addEventListener("focus", onResume);
    window.addEventListener("online", onResume);
    window.addEventListener("alraesy-network-restored", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      disposed = true;
      window.clearTimeout(first);
      window.clearInterval(periodic);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("online", onResume);
      window.removeEventListener("alraesy-network-restored", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, []);

  if (!available || available === dismissed) return null;

  async function update() {
    if (busy || !window.confirm(
      "يتوفر تحديث جديد. احفظ الفاتورة أو أي تعديل غير محفوظ أولًا؛ سيُعاد فتح الصفحة بعد التحديث الشامل. هل تريد المتابعة؟",
    )) return;
    setBusy(true);
    setError("");
    try {
      await refreshEntireApp();
    } catch (reason) {
      setBusy(false);
      setError(reason instanceof Error ? reason.message : "تعذر التحديث؛ حاول مجددًا بعد الاتصال.");
    }
  }

  return (
    <aside className="app-update-prompt" aria-label="تحديث جديد للموقع" role="status" aria-live="polite">
      <div className="app-update-prompt-content">
        <strong>يتوفر تحديث جديد للموقع</strong>
        <span>احفظ الأعمال المفتوحة قبل تحديث الصفحة.</span>
        {error && <span className="app-update-prompt-error" role="alert">{error}</span>}
      </div>
      <button type="button" className="app-update-prompt-action" disabled={busy}
        onClick={() => { void update(); }}>
        <RefreshCw size={15} aria-hidden="true" />
        {busy ? "جارٍ التحديث…" : "تحديث شامل"}
      </button>
      <button type="button" className="app-update-prompt-dismiss"
        disabled={busy} aria-label="لاحقًا" title="لاحقًا"
        onClick={() => { setDismissed(available); setError(""); }}>
        <X size={17} aria-hidden="true" />
      </button>
    </aside>
  );
}
