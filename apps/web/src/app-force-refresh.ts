/** Refresh the deployed app shell, including installed PWA windows.
 *
 * The service worker uses network-first HTML and hash-named build chunks.
 * A cache-busted navigation therefore obtains the newest HTML and its
 * matching JS/CSS without wiping the offline item catalog, drafts or queues.
 * Browsers do not expose an exact Ctrl+F5 shortcut to web applications.
 */
export async function refreshEntireApp(): Promise<void> {
  if (!navigator.onLine) {
    throw new Error("اتصل بالإنترنت أولًا لتحديث إصدار الموقع بالكامل.");
  }
  // Verify an actual server response BEFORE leaving the current screen.
  // This avoids sacrificing an unsaved editor when the network is broken.
  const response = await fetch("/?alraesy-update-check=" + Date.now(), {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "text/html" },
  });
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error("تعذر تحميل الإصدار الجديد من الموقع. حاول مرة أخرى بعد عودة الاتصال.");
  }
  const html = await response.text();
  if (!html.includes('id="root"') || !/\/assets\/[^"']+\.js/.test(html)) {
    throw new Error("لم يتم التأكد من ملفات الإصدار الجديد؛ لم تُغلق الصفحة الحالية.");
  }
  // Ask Chrome/Edge to check for an updated PWA worker. This is best-effort:
  // the new navigation is network-first and must not wait for large offline
  // asset downloads; they remain available and will refresh in background.
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistration().then(registration => {
      if (!registration) return;
      void registration.update().catch(() => {});
      registration.active?.postMessage({ type: "alraesy:warm-static" });
    }).catch(() => {});
  }
  const target = new URL(window.location.href);
  target.searchParams.set("alraesy-fresh", Date.now().toString());
  // Preserve path, company, search filters and hash; the worker's navigation
  // handler performs a no-store network fetch of this URL.
  window.location.replace(target.href);
}
