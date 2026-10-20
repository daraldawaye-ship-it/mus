import { useState, useSyncExternalStore } from "react";
import { Download } from "lucide-react";
import { DevicePushBootstrap } from "./DeviceNotificationSettings";
import {
  appleMobile, installInstructions, installSnapshot, observeInstall, requestInstall,
} from "./app-install";
import { Button, Card, Notice } from "./ui";

/** Always present until the applicable device steps actually succeed. There is
 * no saved dismissal or user preference hiding setup from subsequent visits. */
export function AppSetup({ userId }: { userId?: number }) {
  const install = useSyncExternalStore(observeInstall, installSnapshot);
  const [copyMessage, setCopyMessage] = useState("");
  const apple = appleMobile(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyMessage("تم نسخ الرابط. الصقه في متصفح هاتفك.");
    } catch {
      setCopyMessage("انسخ الرابط من شريط العنوان وافتحه في متصفح هاتفك.");
    }
  }
  return <section className="app-device-setup" aria-label="إعداد التطبيق والإشعارات">
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
    {userId ? <DevicePushBootstrap key={userId} userId={userId} /> :
      !install.installed && <p className="muted">بعد تسجيل الدخول ستظهر خطوة تفعيل إشعارات العمل تلقائيًا.</p>}
  </section>;
}
