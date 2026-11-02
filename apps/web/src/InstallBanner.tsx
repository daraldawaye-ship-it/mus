import { useState, useSyncExternalStore } from "react";
import { Download, Share2, Smartphone, MonitorDown } from "lucide-react";
import {
  appleMobile, installInstructions, installSnapshot, observeInstall, requestInstall,
} from "./app-install";

/** Always-visible, ordinary-flow install invitation at the TOP of browser
 * sessions, including account creation and one-use direct-login links.
 * Browsers alone decide whether/when a native install prompt is allowed.
 */
export function InstallBanner() {
  const install = useSyncExternalStore(observeInstall, installSnapshot);
  const [showGuide, setShowGuide] = useState(false);
  const apple = appleMobile(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  const android = /Android/i.test(navigator.userAgent);
  const phone = apple || android || /Mobile|Mobi/i.test(navigator.userAgent);
  const embedded = /FBAN|FBAV|Instagram|\bwv\b|; wv\)|WhatsApp|Line\//i.test(navigator.userAgent);

  if (install.installed) return null;

  function installNow() {
    // A native prompt can only open synchronously from this user's click.
    if (install.prompt) {
      void requestInstall();
      return;
    }
    setShowGuide(true);
  }

  return (
    <aside className="app-install-banner" aria-label="تثبيت تطبيق الرئيسي"
      data-install-platform={apple ? "ios" : android ? "android" : "desktop"}>
      <div className="app-install-banner-heading">
        <img src="/site-icon.png" alt="" className="app-install-banner-icon" />
        <div className="app-install-banner-copy">
          <strong>ثبّت تطبيق الرئيسي على جهازك</strong>
          <span>افتحه من الشاشة الرئيسية مباشرة، واستفد من مزايا العمل دون إنترنت.</span>
          {apple && <small>للآيفون: مشاركة <Share2 size={13} aria-hidden="true" /> إضافة إلى الشاشة الرئيسية</small>}
        </div>
      </div>
      <button type="button" className="app-install-banner-action"
        onClick={installNow} disabled={install.busy}>
        {apple || phone ? <Smartphone size={21} aria-hidden="true" /> :
          <MonitorDown size={21} aria-hidden="true" />}
        {install.busy ? "جارٍ فتح التثبيت…" :
          apple ? "تثبيت التطبيق على الآيفون" :
          phone ? "تثبيت التطبيق على الهاتف" : "تثبيت التطبيق على اللابتوب"}
        <Download size={18} aria-hidden="true" />
      </button>
      {install.message && <p className="app-install-banner-message" role="status">{install.message}</p>}
      {showGuide && <div className="app-install-banner-guide" role="status">
        <strong>{apple ? "طريقة التثبيت على الآيفون" :
          android ? "طريقة التثبيت على أندرويد" : "طريقة التثبيت على اللابتوب"}</strong>
        {apple ? (
          <ol>
            {embedded && <li>افتح هذا الرابط في متصفح Safari بدل متصفح واتساب أو التطبيق الآخر.</li>}
            <li>في Safari اضغط <b>المشاركة</b> <Share2 size={16} aria-label="رمز المشاركة" /> من قائمة الصفحة.</li>
            <li>اختر <b>إضافة إلى الشاشة الرئيسية</b>.</li>
            <li>إن ظهر خيار <b>فتح كتطبيق ويب</b> فاتركه مفعّلًا، ثم اضغط <b>إضافة</b>.</li>
            <li>افتح <b>الرئيسي</b> من الأيقونة الجديدة على الشاشة الرئيسية.</li>
          </ol>
        ) : <p>{installInstructions(false, navigator.userAgent)}</p>}
        <small>لا يحتاج الأمر إلى متجر التطبيقات. إذا لم يظهر خيار التثبيت، جرّب متصفحًا داعمًا.</small>
      </div>}
    </aside>
  );
}
