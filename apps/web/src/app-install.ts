export type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
type InstallState = {
  installed: boolean;
  prompt: InstallPrompt | null;
  busy: boolean;
  message: string;
};

export function appleMobile(userAgent: string, platform: string, touchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && touchPoints > 1);
}

export function installInstructions(apple: boolean, userAgent: string): string {
  if (/FBAN|FBAV|Instagram|\bwv\b|; wv\)|WhatsApp|Line\//i.test(userAgent))
    return apple
      ? "من قائمة التطبيق الذي فتحت منه الرابط اختر «فتح في المتصفح»، أو انسخ الرابط وافتحه في Safari. ثم من قائمة المشاركة اختر «إضافة إلى الشاشة الرئيسية»، وافتح التطبيق من أيقونته."
      : "من قائمة التطبيق الذي فتحت منه الرابط اختر «فتح في المتصفح». إن لم يظهر الخيار، انسخ الرابط وافتحه في متصفح هاتفك، ثم اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».";
  if (apple) return "افتح قائمة المشاركة في المتصفح، ثم «إضافة إلى الشاشة الرئيسية» و«إضافة». إذا لم يظهر الخيار، افتح الرابط في Safari. بعدها افتح الرئيسي من أيقونته لتفعيل الإشعارات.";
  if (/Firefox\//.test(userAgent) && /Android/.test(userAgent))
    return "في Firefox افتح القائمة ⋮ ثم «تثبيت» أو «إضافة إلى الشاشة الرئيسية»، وأكّد الإضافة.";
  if (/Android/.test(userAgent))
    return "افتح قائمة المتصفح ⋮ أو ☰ واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية»، ثم أكّد التثبيت. يعمل ذلك في المتصفحات الداعمة مثل Chrome وEdge وSamsung Internet؛ إذا غاب الخيار جرّب أحدها.";
  return "اختر أيقونة التثبيت بجانب عنوان الموقع أو «تثبيت التطبيق» من قائمة المتصفح. إذا لم تجدها جرّب Chrome أو Edge. إذا كان التطبيق مثبتًا، افتحه من أيقونته.";
}

const listeners = new Set<() => void>();
export const isAppWindow = () => ["standalone", "minimal-ui", "window-controls-overlay"]
  .some(mode => window.matchMedia(`(display-mode: ${mode})`).matches) ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
let state: InstallState = { installed: isAppWindow(), prompt: null, busy: false, message: "" };
function update(patch: Partial<InstallState>) {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}
export const installSnapshot = () => state;
export function observeInstall(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Imported before React mounts: browsers may emit this event before login or
// the authenticated shell finishes loading. Keep it for the visible setup step.
window.addEventListener("beforeinstallprompt", event => {
  const prompt = event as InstallPrompt;
  if (typeof prompt.prompt !== "function") return;
  event.preventDefault();
  update({ prompt, message: "" });
});
window.addEventListener("appinstalled", () => {
  update({ installed: true, prompt: null, busy: false, message: "" });
});
const displayMode = window.matchMedia("(display-mode: standalone)");
displayMode.addEventListener?.("change", () => update({ installed: isAppWindow() }));
window.addEventListener("pageshow", () => {
  if (isAppWindow()) update({ installed: true, prompt: null });
});

export async function requestInstall(): Promise<void> {
  const prompt = state.prompt;
  if (!prompt || state.busy) return;
  update({ busy: true, message: "" });
  try {
    // Invoke synchronously from the click, before any asynchronous preparation.
    const requesting = prompt.prompt();
    update({ prompt: null }); // A BeforeInstallPromptEvent can be used only once.
    await requesting;
    const choice = await prompt.userChoice;
    if (!state.installed) update({ message: choice.outcome === "accepted"
      ? "أكمل تثبيت التطبيق في نافذة المتصفح، ثم افتحه من أيقونته."
      : "لم يكتمل التثبيت. يمكنك إتمامه من قائمة المتصفح باتباع الخطوات أدناه." });
  } catch {
    update({ prompt: null, message: "تعذر فتح نافذة التثبيت. اتبع خطوات متصفحك أدناه." });
  } finally {
    update({ busy: false });
  }
}

export function prepareInstall(): void {
  if (window.isSecureContext && "serviceWorker" in navigator) {
    // This worker handles notifications only; it never caches private API data.
    const warmStaticAssets = () => {
      if (!navigator.onLine || document.visibilityState === "hidden") return;
      void navigator.serviceWorker.ready.then(registration => {
        (registration.active ?? navigator.serviceWorker.controller)
          ?.postMessage({ type: "alraesy:warm-static" });
      }).catch(() => {});
    };
    void navigator.serviceWorker.register("/push-sw.js", {
      scope: "/", updateViaCache: "none",
    }).then(async registration => {
      await registration.update();
      warmStaticAssets();
    }).catch(() => {});
    window.addEventListener("online", warmStaticAssets);
    document.addEventListener("visibilitychange", warmStaticAssets);
  }
}
