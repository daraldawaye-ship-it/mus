import { useEffect, useState, useSyncExternalStore } from "react";
import { Download } from "lucide-react";
import { DevicePushBootstrap } from "./DeviceNotificationSettings";
import {
  appleMobile, installInstructions, installSnapshot, observeInstall, requestInstall,
} from "./app-install";
import { Button, Card, Notice } from "./ui";
import { OfflineStatus } from "./OfflineStatus";

/** Always present until the applicable device steps actually succeed. There is
 * no saved dismissal or user preference hiding setup from subsequent visits. */
export function AppSetup({ userId, companyId }: { userId?: number; companyId?: number }) {
  const install = useSyncExternalStore(observeInstall, installSnapshot);
  const [copyMessage, setCopyMessage] = useState("");
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
  const apple = appleMobile(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyMessage("تم نسخ الرابط. الصقه في متصفح هاتفك.");
    } catch {
      setCopyMessage("انسخ الرابط من شريط العنوان وافتحه في متصفح هاتفك.");
    }
  }
  return <section className="app-device-setup" data-alraesy-setup="current"
    data-company-id={companyId ?? ""} aria-label="إعداد التطبيق والإشعارات">
    {!install.installed && <Card title="ثبّت تطبيق الرئيسي على جهازك">
      <p>لتصل إلى عملك مباشرة، أكمل التثبيت من هنا ثم فعّل إشعارات الجهاز.</p>
      <div className="form-actions">
        {install.prompt && <Button disabled={install.busy} onClick={() => void requestInstall()}>
          <Download size={16} aria-hidden="true" />
          {install.busy ? "جارٍ فتح التثبيت…" : "تثبيت التطبيق"}
        </Button>}
        <Button variant="secondary" onClick={() => void copyLink()}>نسخ الرابط لفتحه في المتصفح</Button>
      </div>
      {install.message && <Notice>{install.message}</Notice>}
      <p>{installInstructions(apple, navigator.userAgent)}</p>
      {!install.prompt && <small className="muted">إذا لم تظهر نافذة تثبيت تلقائية، اتبع الخطوات أعلاه. عدم ظهورها لا يعني أن التطبيق مثبت.</small>}
      {copyMessage && <p role="status">{copyMessage}</p>}
    </Card>}
    {userId && <OfflineStatus key={userId} userId={userId} companyId={companyId} />}
    {userId ? <DevicePushBootstrap key={userId} userId={userId} /> :
      !install.installed && <p className="muted">بعد تسجيل الدخول ستظهر خطوة تفعيل إشعارات العمل تلقائيًا.</p>}
  </section>;
}
