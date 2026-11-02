import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(name, "utf8");

test("prominent installer appears between topbar and main content on all routes", () => {
  const app = read("apps/web/src/App.tsx");
  const content = app.indexOf('<InstallBanner />');
  assert.ok(content > app.indexOf("</header>"));
  assert.ok(content < app.indexOf('<main className="main-content"'));
  assert.ok(app.indexOf("<AppSetup") > content, "headless offline/push remains after pages");
  assert.match(app, /<Route path="\/quick-login"/);
  const setup = read("apps/web/src/AppSetup.tsx");
  assert.doesNotMatch(setup, /app-install-guide|تثبيت تطبيق الرئيسي|requestInstall/);
  assert.match(setup, /DevicePushBootstrap/);
  assert.match(setup, /OfflineStatus/);
});

test("installation CTA persists until actual browser/PWA install signal, no coercive prompt", () => {
  const banner = read("apps/web/src/InstallBanner.tsx");
  const install = read("apps/web/src/app-install.ts");
  assert.match(banner, /useSyncExternalStore\(observeInstall, installSnapshot\)/);
  assert.match(banner, /if \(install\.installed\) return null/);
  assert.match(banner, /install\.prompt/);
  assert.match(banner, /void requestInstall\(\)/);
  assert.match(banner, /setShowGuide\(true\)/);
  assert.doesNotMatch(banner, /localStorage|sessionStorage|setTimeout|setInterval/);
  assert.match(install, /window\.addEventListener\("beforeinstallprompt"/);
  assert.match(install, /window\.addEventListener\("appinstalled"/);
  assert.match(install, /const requesting = prompt\.prompt\(\)/);
  assert.match(install, /isAppWindow\(\)/);
});

test("iPhone offers clear share-to-home-screen steps without fake native install", () => {
  const banner = read("apps/web/src/InstallBanner.tsx");
  assert.match(banner, /appleMobile\(navigator\.userAgent/);
  assert.match(banner, /تثبيت التطبيق على الآيفون/);
  assert.match(banner, /افتح هذا الرابط في متصفح Safari/);
  assert.match(banner, /إضافة إلى الشاشة الرئيسية/);
  assert.match(banner, /فتح كتطبيق ويب/);
  assert.match(banner, /متجر التطبيقات/);
  assert.match(banner, /WhatsApp/);
  assert.match(banner, /window\.location\.hash|beforeinstallprompt/);
});

test("large readable, mobile responsive and print-hidden banner", () => {
  const css = read("apps/web/src/styles.css");
  assert.match(css, /\.app-install-banner \{/);
  assert.match(css, /\.app-install-banner-action \{/);
  assert.match(css, /font-size: 17px/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media print \{ \.app-install-banner \{ display: none !important; \} \}/);
  const manifest = JSON.parse(read("apps/web/public/site.webmanifest"));
  assert.equal(manifest.display,"standalone");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.scope, "/");
});
