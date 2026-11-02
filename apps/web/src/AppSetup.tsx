import { useEffect } from "react";
import { DevicePushBootstrap } from "./DeviceNotificationSettings";
import { OfflineStatus } from "./OfflineStatus";

/** Preserve one headless device bootstrap for push/offline. Installation is
 * promoted in InstallBanner ABOVE the page; do not repeat bottom-page guides.
 */
export function AppSetup({ userId, companyId }: { userId?: number; companyId?: number }) {
  useEffect(() => {
    // A browser can retain older device-setup DOM from a previous application
    // shell. Sibling-only CSS cannot hide copies mounted in separate wrappers.
    // Elect ONE live setup across the entire document, preferring the latest
    // instance with a known company. Do not remove React-managed nodes.
    const reconcile = () => {
      const panels = Array.from(document.querySelectorAll<HTMLElement>(".app-device-setup"));
      const current = panels.filter(panel => panel.dataset.alraesySetup === "current");
      const chosen = current.filter(panel => panel.dataset.companyId !== "").at(-1)
        ?? current.at(-1) ?? panels.at(-1);
      for (const panel of panels) {
        if (panel === chosen) panel.style.removeProperty("display");
        else panel.style.setProperty("display", "none", "important");
      }
    };
    const observer = new MutationObserver(reconcile);
    observer.observe(document.body, { childList: true, subtree: true });
    reconcile();
    return () => {
      observer.disconnect();
      // When the elected setup unmounts, a remaining setup can be shown.
      queueMicrotask(() => {
        const panels = Array.from(document.querySelectorAll<HTMLElement>(".app-device-setup"));
        if (panels.length === 1) panels[0].style.removeProperty("display");
      });
    };
  }, [userId, companyId]);

  return <section className="app-device-setup" data-alraesy-setup="current"
    data-company-id={companyId ?? ""} aria-label="إعداد الإشعارات ومزامنة البيانات">
    {userId && <OfflineStatus key={userId} userId={userId} companyId={companyId} />}
    {userId && <DevicePushBootstrap key={userId} userId={userId} />}
  </section>;
}
