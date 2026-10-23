import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

// A real React/browser integration with device and HTTP boundaries mocked.
// It needs no database, employee records, or production account.
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  configFile: false,
  root,
  plugins: [react()],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
});
await vite.listen();
const origin = vite.resolvedUrls?.local[0];
assert.ok(origin, "Vite must expose the fixture origin");
const chromiumPath = process.env.CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
type ProbeOptions = {
  signedIn?: boolean;
  installed?: boolean;
  earlyPrompt?: boolean;
  supported?: boolean;
  permission?: NotificationPermission;
  answer?: NotificationPermission;
  subscribed?: boolean;
  storageThrows?: boolean;
  platform?: string;
  touchPoints?: number;
  userAgent?: string;
  failSubscribe?: number;
  failConfig?: boolean;
  disabledConfig?: boolean;
  unverifiedStatus?: boolean;
};
type Probe = {
  permissionRequests: number;
  permissionHadGesture: boolean;
  pushSubscriptions: number;
  registrations: number;
};
const android = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36";
let passed = 0;

async function scenario(label: string, options: ProbeOptions, run: (page: Page, counts: { subscribe: number; config: number }) => Promise<void>) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: options.userAgent ?? android,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const counts = { subscribe: 0, config: 0 };
  const deviceSetup = (settings: ProbeOptions) => {
    const probe = {
      earlyPrompt: settings.earlyPrompt,
      permissionRequests: 0,
      permissionHadGesture: false,
      pushSubscriptions: 0,
      registrations: 0,
    };
    Object.defineProperty(window, "setupProbe", { value: probe, configurable: true });
    Object.defineProperty(navigator, "platform", { value: settings.platform ?? "Linux armv8l", configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: settings.touchPoints ?? 5, configurable: true });
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const native = matchMedia(query);
      return query.startsWith("(display-mode:")
        ? {
          matches: Boolean(settings.installed && query === "(display-mode: standalone)"),
          media: query,
          onchange: null,
          addListener() {}, removeListener() {}, dispatchEvent() { return true; },
          addEventListener() {}, removeEventListener() {},
        } as MediaQueryList
        : native;
    };
    let permission: NotificationPermission = settings.permission ?? "default";
    class DeviceNotification {
      static get permission() { return permission; }
      static requestPermission() {
        probe.permissionRequests++;
        probe.permissionHadGesture = navigator.userActivation.isActive;
        permission = settings.answer ?? "granted";
        return Promise.resolve(permission);
      }
    }
    Object.defineProperty(window, "Notification", { value: DeviceNotification, configurable: true });
    Object.defineProperty(window, "PushManager", { value: class {}, configurable: true });
    const deviceSubscription = {
      endpoint: "https://push.example.test/device",
      toJSON: () => ({ endpoint: "https://push.example.test/device", keys: { p256dh: "test-p256dh", auth: "test-auth" } }),
      unsubscribe: async () => true,
    };
    let subscription = settings.subscribed ? deviceSubscription : null;
    const registration = {
      active: { state: "activated" },
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => { probe.pushSubscriptions++; subscription = deviceSubscription; return subscription; },
      },
      showNotification: async () => {},
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        register: async () => { probe.registrations++; return registration; },
        getRegistration: async () => registration,
      },
    });
    if (settings.supported === false) {
      Reflect.deleteProperty(window, "Notification");
      Reflect.deleteProperty(window, "PushManager");
    }
    if (settings.storageThrows) {
      for (const method of ["getItem", "setItem", "removeItem"])
        Object.defineProperty(Storage.prototype, method, { value() { throw new Error("storage unavailable"); }, configurable: true });
    }
  };
  // tsx may preserve names with an esbuild __name helper inside serialized
  // callbacks. Include that harmless helper in the same init script.
  await context.addInitScript({ content:
    "globalThis.__name = (target, value) => Object.defineProperty(target, 'name', { value, configurable: true });\n(" +
    deviceSetup.toString() + ")(" + JSON.stringify(options) + ");",
  });
  await page.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/session") {
      await route.fulfill({ json: { user: options.signedIn ? { id: 7, name: "موظف", displayName: "موظف", owner: false, kind: "member" } : null, csrf: "fixture-csrf" } });
    } else if (pathname === "/api/push/config") {
      counts.config++;
      if (options.failConfig) {
        await route.fulfill({ status: 503, json: { error: { code: "offline", message: "تعذر فحص إعداد الإشعارات" } } });
      } else {
        await route.fulfill({ json: { enabled: !options.disabledConfig, publicKey: options.disabledConfig ? null : Buffer.alloc(65, 1).toString("base64url") } });
      }
    } else if (pathname === "/api/push/subscribe") {
      counts.subscribe++;
      assert.equal(route.request().method(), "POST");
      const body = route.request().postDataJSON() as { endpoint?: string; keys?: { auth?: string } };
      assert.equal(body.endpoint, "https://push.example.test/device");
      assert.equal(body.keys?.auth, "test-auth");
      if (counts.subscribe <= (options.failSubscribe ?? 0)) {
        await route.fulfill({ status: 503, json: { error: { code: "retry", message: "تعذر ربط الجهاز بالخادم" } } });
      } else await route.fulfill({ json: { enabled: true } });
    } else if (pathname === "/api/push/status") {
      await route.fulfill({ json: { devices: !options.unverifiedStatus && counts.subscribe > (options.failSubscribe ?? 0) ? 1 : 0 } });
    } else await route.fulfill({ status: 404, json: { error: { code: "fixture_missing", message: pathname } } });
  });
  try {
    await page.goto(`${origin}tests/fixtures/app-setup.html${options.signedIn ? "?signed-in" : ""}`);
    await run(page, counts);
    assert.deepEqual(errors, [], `Unexpected browser error in ${label}`);
    passed++;
    console.log(`PASS ${label}`);
  } finally {
    await context.close();
  }
}
const pushRegion = (page: Page) => page.getByRole("region", { name: "إشعارات الجهاز", exact: true });
const probe = (page: Page) => page.evaluate(() => (window as unknown as Window & { setupProbe: Probe }).setupProbe);
async function noNativeRequest(page: Page) {
  assert.equal((await probe(page)).permissionRequests, 0);
}
try {
  await scenario("guest always sees install/manual setup without an install event", {}, async page => {
    await page.getByRole("heading", { name: "ثبّت تطبيق الرئيسي على جهازك" }).waitFor();
    await page.getByText("عدم ظهورها لا يعني أن التطبيق مثبت.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "تثبيت التطبيق", exact: true }).count(), 0);
    await noNativeRequest(page);
  });
  await scenario("early install event survives mounting and only click invokes native prompt", { earlyPrompt: true }, async page => {
    const button = page.getByRole("button", { name: "تثبيت التطبيق", exact: true });
    await button.waitFor();
    assert.equal(await page.evaluate(() => (window as Window & { installRequests?: number }).installRequests ?? 0), 0);
    await button.click();
    await page.getByText("أكمل تثبيت التطبيق في نافذة المتصفح", { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => (window as Window & { installRequests?: number }).installRequests), 1);
    assert.equal(await page.evaluate(() => (window as Window & { installHadGesture?: boolean }).installHadGesture), true);
    await page.getByRole("heading", { name: "ثبّت تطبيق الرئيسي على جهازك" }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    await page.getByRole("heading", { name: "ثبّت تطبيق الرئيسي على جهازك" }).waitFor({ state: "hidden" });
  });
  await scenario("standalone launch omits completed install step", { installed: true }, async page => {
    await page.locator('[aria-label="إعداد التطبيق والإشعارات"]').waitFor({ state: "attached" });
    assert.equal(await page.getByRole("heading", { name: "ثبّت تطبيق الرئيسي على جهازك" }).count(), 0);
  });
  await scenario("Firefox Android receives its own manual path", { userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0" }, async page => {
    await page.getByText("في Firefox افتح القائمة", { exact: false }).waitFor();
  });
  await scenario("iPad desktop mode receives installation guidance before support denial", {
    signedIn: true, supported: false, platform: "MacIntel", touchPoints: 5,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  }, async page => {
    await pushRegion(page).waitFor();
    await page.getByText("إضافة إلى الشاشة الرئيسية", { exact: false }).first().waitFor();
    assert.match(await pushRegion(page).innerText(), /الشاشة الرئيسية|المثبت/);
    await noNativeRequest(page);
  });
  await scenario("blocked permission is visible immediately and does not invoke a denied native dialog", {
    signedIn: true, permission: "denied", storageThrows: true,
  }, async page => {
    await pushRegion(page).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="إشعارات الجهاز"]')?.textContent?.match(/محظور|حظر|منع/));
    await noNativeRequest(page);
    assert.equal(await page.getByRole("button", { name: "لاحقًا", exact: true }).count(), 0);
  });
  await scenario("permission request needs a click and setup completes after server registration", {
    signedIn: true, permission: "default", storageThrows: true,
  }, async (page, counts) => {
    const button = pushRegion(page).getByRole("button", { name: /تفعيل.*إشعارات/ });
    await button.waitFor();
    await noNativeRequest(page);
    assert.equal(counts.subscribe, 0);
    await button.click();
    await pushRegion(page).waitFor({ state: "hidden" });
    assert.equal((await probe(page)).permissionRequests, 1);
    assert.equal((await probe(page)).permissionHadGesture, true);
    assert.equal(counts.subscribe, 1);
  });
  await scenario("dismissed permission is requested again after every authenticated page visit", {
    signedIn: true, permission: "default", answer: "default",
  }, async page => {
    for (let visit = 0; visit < 3; visit++) {
      if (visit) await page.reload();
      const region = pushRegion(page);
      await region.getByRole("button", { name: /تفعيل.*إشعارات/ }).waitFor();
      await noNativeRequest(page);
      // A stale marker from the old implementation must not suppress a visit.
      await page.evaluate(() => sessionStorage.setItem("alraesy:push-prompted:7", "1"));
      await page.getByRole("heading", { name: "ثبّت تطبيق الرئيسي على جهازك" }).click();
      await page.waitForFunction(() =>
        (window as unknown as { setupProbe: Probe }).setupProbe.permissionRequests === 1);
      await region.getByText("لم تكتمل موافقة الجهاز", { exact: false }).waitFor();
      await page.getByRole("heading", { name: "ثبّت تطبيق الرئيسي على جهازك" }).click();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await region.getByRole("button", { name: /تفعيل.*إشعارات/ }).waitFor({ state: "visible" });
      assert.equal((await probe(page)).permissionRequests, 1, "ordinary interactions must not repeatedly prompt within a visit");
      assert.equal((await probe(page)).permissionHadGesture, true);
    }
  });
  await scenario("blocked permission reminder returns on every visit without a native request", {
    signedIn: true, permission: "denied",
  }, async page => {
    for (let visit = 0; visit < 2; visit++) {
      if (visit) await page.reload();
      await pushRegion(page).getByText("الإشعارات محظورة", { exact: false }).waitFor();
      await page.getByRole("heading", { name: "ثبّت تطبيق الرئيسي على جهازك" }).click();
      await noNativeRequest(page);
    }
  });
  await scenario("failed subscription remains visible and can retry without a second native request", {
    signedIn: true, permission: "default", failSubscribe: 1,
  }, async (page, counts) => {
    await pushRegion(page).getByRole("button", { name: /تفعيل.*إشعارات/ }).click();
    await pushRegion(page).getByText("تعذر ربط الجهاز بالخادم", { exact: false }).waitFor();
    assert.equal(counts.subscribe, 1);
    await pushRegion(page).getByRole("button").filter({ hasText: /محاولة|تفعيل|تحقق|تحقّق/ }).first().click();
    await pushRegion(page).waitFor({ state: "hidden" });
    assert.equal(counts.subscribe, 2);
    assert.equal((await probe(page)).permissionRequests, 1);
  });
  await scenario("granted permission reconnects automatically without asking permission again", {
    signedIn: true, permission: "granted", subscribed: true,
  }, async (page, counts) => {
    await page.waitForFunction(() => {
      const state = (window as Window & { setupProbe?: Probe }).setupProbe;
      return Boolean(state && state.registrations > 0 && document.querySelector('[aria-label="إشعارات الجهاز"]') === null);
    });
    assert.ok(counts.subscribe >= 1);
    await noNativeRequest(page);
  });
  await scenario("permission and subscribe response alone do not claim an active server binding", {
    signedIn: true, permission: "granted", unverifiedStatus: true,
  }, async page => {
    await pushRegion(page).getByText("لم يكتمل ربط إشعارات هذا الجهاز بالحساب", { exact: false }).waitFor();
    await noNativeRequest(page);
  });
  await scenario("configuration failure is visible instead of silently hiding setup", {
    signedIn: true, failConfig: true,
  }, async page => {
    await pushRegion(page).getByText("تعذر فحص إعداد الإشعارات", { exact: false }).waitFor();
    await noNativeRequest(page);
  });
  console.log(`${passed} app setup browser scenarios passed`);
} finally {
  await browser.close();
  await vite.close();
}
