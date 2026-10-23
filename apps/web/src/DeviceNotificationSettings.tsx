import { useEffect, useRef, useState } from "react";
import { api, useSession } from "./api";
import { Button, Card, Notice } from "./ui";
import { automaticPushPromptAllowed } from "./push-permission-policy";

type Config = { enabled: boolean; publicKey: string | null };
type Status = "loading" | "unsupported" | "ios-install" | "disabled" |
  "blocked" | "active" | "available" | "error";

function vapidBytes(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - text.length % 4) % 4));
  const result = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
  return result;
}

export function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window &&
    "Notification" in window && window.isSecureContext;
}

export function onApplePhone(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function iosInstalled(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

type SubscriptionScope = { signal?: AbortSignal; isCurrent?: () => boolean };
function assertCurrent(scope: SubscriptionScope) {
  scope.signal?.throwIfAborted();
  if (scope.isCurrent && !scope.isCurrent())
    throw new DOMException("انتهت جلسة إعداد الإشعارات", "AbortError");
}

function waitForDevice<T>(pending: Promise<T>, scope: SubscriptionScope = {}): Promise<T> {
  assertCurrent(scope);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      finish();
      reject(new Error("تعذر إكمال إعداد الإشعارات. تحقق من الاتصال ثم أعد المحاولة."));
    }, 15000);
    const aborted = () => {
      finish();
      reject(new DOMException("انتهت جلسة إعداد الإشعارات", "AbortError"));
    };
    const finish = () => {
      window.clearTimeout(timeout);
      scope.signal?.removeEventListener("abort", aborted);
    };
    scope.signal?.addEventListener("abort", aborted, { once: true });
    pending.then((result) => {
      finish();
      resolve(result);
    }, (cause: unknown) => {
      finish();
      reject(cause);
    });
  });
}

function readyWorker(scope: SubscriptionScope): Promise<ServiceWorkerRegistration> {
  return waitForDevice(navigator.serviceWorker.ready, scope);
}

export async function subscribeDevice(publicKey: string, scope: SubscriptionScope = {}): Promise<void> {
  if (!supported()) throw new Error("هذا المتصفح لا يدعم إشعارات الويب.");
  assertCurrent(scope);
  await waitForDevice(navigator.serviceWorker.register("/push-sw.js", { scope: "/" }), scope);
  const registration = await readyWorker(scope);
  assertCurrent(scope);
  let subscription = await waitForDevice(registration.pushManager.getSubscription(), scope);
  assertCurrent(scope);
  if (!subscription) {
    subscription = await waitForDevice(registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: vapidBytes(publicKey),
    }), scope);
  }
  assertCurrent(scope);
  const keys = subscription.toJSON().keys;
  if (!keys?.p256dh || !keys.auth)
    throw new Error("لم تُرجع خدمة الجهاز مفاتيح الاشتراك.");
  await waitForDevice(api("/push/subscribe", {
    method: "POST", signal: scope.signal,
    body: { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
  }), scope);
  assertCurrent(scope);
  const status = await waitForDevice(api<{ devices: number }>("/push/status", { signal: scope.signal }), scope);
  assertCurrent(scope);
  if (Notification.permission !== "granted" || status.devices < 1)
    throw new Error("لم يكتمل ربط إشعارات هذا الجهاز بالحساب. أعد المحاولة.");
}

type PushLifetime = {
  alive: boolean;
  busy: boolean;
  publicKey: string | null;
  controller: AbortController;
  check: () => Promise<void>;
};

/** Ask again on each new site visit, including a reload with an existing login.
 * Only the page-level bootstrap owns automatic requests; settings can coexist. */
function useDevicePush(userId: number | null, automatic = false) {
  const [state, setState] = useState<Status>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lifetime = useRef<PushLifetime | null>(null);
  const automaticPromptAttempted = useRef(false);
  const currentUser = useRef(userId);
  currentUser.current = userId;

  useEffect(() => {
    automaticPromptAttempted.current = false;
    const run: PushLifetime = {
      alive: true, busy: false, publicKey: null,
      controller: new AbortController(), check: async () => {},
    };
    lifetime.current = run;
    const current = () => run.alive && currentUser.current === userId;
    run.check = async () => {
      if (!userId || run.busy || !current()) return;
      run.busy = true;
      setBusy(true);
      setError("");
      try {
        const config = await waitForDevice(api<Config>("/push/config", { signal: run.controller.signal }), {
          signal: run.controller.signal, isCurrent: current,
        });
        if (!current()) return;
        run.publicKey = config.publicKey;
        if (!config.enabled || !config.publicKey) { setState("disabled"); return; }
        // On iOS the APIs can be missing until the Home Screen app is opened.
        if (onApplePhone() && !iosInstalled()) { setState("ios-install"); return; }
        if (!supported()) { setState("unsupported"); return; }
        if (Notification.permission === "denied") { setState("blocked"); return; }
        if (Notification.permission !== "granted") { setState("available"); return; }
        await subscribeDevice(config.publicKey, {
          signal: run.controller.signal, isCurrent: current,
        });
        if (current()) setState("active");
      } catch (cause) {
        if (current()) {
          setState("error");
          setError(cause instanceof Error ? cause.message : "تعذر التحقق من إشعارات الجهاز.");
        }
      } finally {
        run.busy = false;
        if (current()) setBusy(false);
      }
    };
    const refresh = () => { if (document.visibilityState !== "hidden") void run.check(); };
    setState("loading");
    void run.check();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      run.alive = false;
      run.controller.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [userId]);

  async function enable() {
    const run = lifetime.current;
    if (!run?.alive || run.busy || !run.publicKey || !supported()) return;
    const identity = userId;
    const current = () => run.alive && lifetime.current === run && currentUser.current === identity;
    run.busy = true;
    setBusy(true);
    setError("");
    try {
      // This call must stay directly in the button handler, before any await.
      const permission = Notification.permission === "default"
        ? await waitForDevice(Notification.requestPermission(), {
          signal: run.controller.signal, isCurrent: current,
        }) : Notification.permission;
      if (!current()) return;
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "available");
        if (permission === "default")
          setError("لم تكتمل موافقة الجهاز. اضغط تفعيل الإشعارات ثم اختر «السماح» في نافذة المتصفح.");
        return;
      }
      await subscribeDevice(run.publicKey, {
        signal: run.controller.signal, isCurrent: current,
      });
      if (current()) setState("active");
    } catch (cause) {
      if (current()) {
        setState("error");
        setError(cause instanceof Error ? cause.message : "تعذر تفعيل إشعارات الجهاز.");
      }
    } finally {
      run.busy = false;
      if (current()) setBusy(false);
    }
  }

  // Chrome/Android and several other browsers block permission dialogs on page
  // load. Ask on the first ordinary, trusted click or keyboard activation after
  // login, without requiring a special notification-settings button. Keep the
  // native Allow/Deny choice entirely under the user's control.
  useEffect(() => {
    if (!automatic || !userId || state !== "available" || !supported() ||
        Notification.permission !== "default") return;
    const onInteraction = (event: Event) => {
      const key = event instanceof KeyboardEvent ? event.key : undefined;
      if (!automaticPushPromptAllowed(Notification.permission, event.isTrusted, event.type, key)) return;
      if (!lifetime.current?.publicKey || lifetime.current.busy) return;
      if (automaticPromptAttempted.current) return;
      automaticPromptAttempted.current = true;
      // enable() invokes Notification.requestPermission() synchronously before
      // its first await, retaining the gesture required by the browser.
      void enable();
    };
    document.addEventListener("click", onInteraction, true);
    document.addEventListener("keydown", onInteraction, true);
    return () => {
      document.removeEventListener("click", onInteraction, true);
      document.removeEventListener("keydown", onInteraction, true);
    };
  }, [automatic, userId, state]);

  return { state, busy, error, enable, recheck: () => void lifetime.current?.check() };
}

const description: Record<Status, string> = {
  loading: "جارٍ فحص إشعارات هذا الجهاز…",
  disabled: "خدمة إشعارات الأجهزة غير مهيأة في الخادم حاليًا. أعد التحقق لاحقًا أو تواصل مع الإدارة.",
  unsupported: "هذا المتصفح لا يتيح إشعارات الويب هنا. افتح الرابط في متصفح يدعمها، وتأكد من استخدام اتصال HTTPS.",
  "ios-install": "على iPhone وiPad: أضف الموقع إلى الشاشة الرئيسية من قائمة المشاركة، ثم افتح أيقونة الرئيسي لتفعيل الإشعارات. يلزم iOS أو iPadOS 16.4 أو أحدث.",
  blocked: "الإشعارات محظورة من المتصفح أو الجهاز. اسمح بإشعارات الرئيسي من إعدادات الموقع أو إعدادات إشعارات التطبيق، ثم اضغط «إعادة التحقق».",
  active: "تم التحقق من إذن الإشعارات وربط هذا الجهاز بالحساب.",
  available: "سيطلب المتصفح إذن إشعارات العمل تلقائيًا عند أول تفاعل داخل الموقع. اختر «السماح» من نافذة النظام مرة واحدة.",
  error: "لم يكتمل إعداد إشعارات هذا الجهاز. تحقق من الاتصال ثم أعد المحاولة.",
};

function NotificationHelp({ expanded = false }: { expanded?: boolean }) {
  return <details className="notification-device-help" open={expanded || undefined}>
    <summary>طريقة السماح بالإشعارات وتشغيل الصوت والتنبيه</summary>
    {onApplePhone() ? (
      <p>على iPhone وiPad: افتح <strong>الإعدادات ← الإشعارات ← الرئيسي (Alraesy)</strong>، ثم فعّل «السماح بالإشعارات» و«الأصوات» و«اللافتات». افتح التطبيق من أيقونته في الشاشة الرئيسية، وتأكد من أن وضع التركيز لا يكتم التنبيهات.</p>
    ) : (
      <p>على Android: افتح <strong>إعدادات المتصفح ← إعدادات المواقع أو أذونات المواقع ← الإشعارات</strong> واسمح لهذا الموقع. ومن إعدادات الهاتف افتح «التطبيقات ← الرئيسي أو المتصفح الذي تستخدمه ← الإشعارات» وفعّل السماح والصوت والتنبيه العائم إن توفّر. على الكمبيوتر افتح أذونات الموقع بجانب عنوانه واسمح بالإشعارات، ثم راجع إشعارات المتصفح في إعدادات النظام.</p>
    )}
    <p className="muted">السماح بالإشعارات والصوت واللافتات يخضع لإعدادات الجهاز؛ لا يمكن للموقع تشغيلها نيابةً عنك.</p>
  </details>;
}

function PushAction({ push }: { push: ReturnType<typeof useDevicePush> }) {
  if (push.state === "loading" || push.state === "active") return null;
  return <Button size="compact" disabled={push.busy}
    onClick={push.state === "available" ? () => void push.enable() : push.recheck}>
    {push.busy ? "جارٍ التحقق…" : push.state === "available" ? "تفعيل الإشعارات" : "إعادة التحقق"}
  </Button>;
}

export function DevicePushBootstrap({ userId, onReadyChange }: {
  userId: number;
  onReadyChange?: (ready: boolean) => void;
}) {
  const push = useDevicePush(userId, true);
  useEffect(() => onReadyChange?.(push.state === "active"), [push.state, onReadyChange]);
  // Keep a reminder and explicit retry visible after a dismissed native request.
  if (push.state === "active" || push.state === "loading") return null;
  return <div className="device-push-invite" role="region" aria-label="إشعارات الجهاز">
    <strong>تفعيل إشعارات العمل</strong>
    <span role="status">{description[push.state]}</span>
    {push.error && <Notice tone="error">{push.error}</Notice>}
    <div className="device-push-invite-actions"><PushAction push={push} /></div>
    {(push.state === "blocked" || push.state === "unsupported") &&
      <NotificationHelp expanded={push.state === "blocked"} />}
  </div>;
}

export function DeviceNotificationSettings() {
  const { user } = useSession();
  const push = useDevicePush(user?.id ?? null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [testError, setTestError] = useState("");
  const currentUser = useRef(user?.id);
  currentUser.current = user?.id;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    setTestBusy(false);
    setTestResult("");
    setTestError("");
  }, [user?.id]);

  async function testNotification() {
    if (testBusy || !supported() || Notification.permission !== "granted") return;
    const identity = user?.id;
    const current = () => alive.current && currentUser.current === identity;
    setTestBusy(true); setTestResult(""); setTestError("");
    try {
      await waitForDevice(navigator.serviceWorker.register("/push-sw.js", { scope: "/" }), { isCurrent: current });
      const registration = await readyWorker({ isCurrent: current });
      if (!current()) return;
      await registration.showNotification("تجربة إشعار من الرئيسي", {
        body: "هذا إشعار تجريبي لتفقد ظهور التنبيه والصوت على جهازك.",
        icon: "/site-icon.png", badge: "/site-icon.png", tag: "alraesy-notification-test",
        silent: false, vibrate: [200, 100, 200],
      } as NotificationOptions & { vibrate: number[] });
      if (current()) setTestResult("تم إرسال إشعار تجريبي إلى نظام الجهاز. تحقق من ظهوره؛ إن وصل بصمت راجع إعدادات الصوت والتنبيه أدناه.");
    } catch (cause) {
      if (current()) setTestError(cause instanceof Error ? cause.message : "تعذر إرسال الإشعار التجريبي.");
    } finally {
      if (current()) setTestBusy(false);
    }
  }

  return <Card title="إشعارات الجهاز">
    <p className="muted" role="status">{description[push.state]}</p>
    {push.error && <Notice tone="error">{push.error}</Notice>}
    <div className="form-actions"><PushAction push={push} /></div>
    {push.state === "active" && <div className="form-actions">
      <Button variant="secondary" disabled={testBusy} onClick={() => void testNotification()}>
        {testBusy ? "جارٍ الإرسال…" : "تجربة إشعار على هذا الجهاز"}
      </Button>
      {testResult && <Notice tone="success">{testResult}</Notice>}
      {testError && <Notice tone="error">{testError}</Notice>}
    </div>}
    <NotificationHelp expanded={push.state === "blocked"} />
    <small className="muted">إشعارات العمل مفعلة داخل الموقع. موافقة المتصفح مستقلة لكل جهاز ومتصفح، ويلزم إكمال إعدادها مرة على كل جهاز تستخدمه.</small>
  </Card>;
}
