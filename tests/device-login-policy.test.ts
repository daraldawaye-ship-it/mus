import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compactDesktopTextSecret, mobileInstalledApp } from "../apps/web/src/device-login-policy.ts";

test("phone PWA keeps password-manager integration online and offline", () => {
  assert.equal(mobileInstalledApp("Mozilla/5.0 (iPhone; CPU iPhone OS 18_4)",true),true);
  assert.equal(mobileInstalledApp("Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36",true),true);
  assert.equal(mobileInstalledApp("Mozilla/5.0 (iPad; CPU OS 18_4)",true),true);
  assert.equal(mobileInstalledApp("Mozilla/5.0 (Macintosh; Intel Mac OS X)",true,"MacIntel",5),true);
});

test("laptop browser or installed laptop PWA never opts into app password autofill", () => {
  const windows="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157 Safari/537.36";
  const mac="Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 Safari/605.1.15";
  assert.equal(mobileInstalledApp(windows,true),false);
  assert.equal(mobileInstalledApp(windows,false),false);
  assert.equal(mobileInstalledApp(mac,true),false);
  assert.equal(mobileInstalledApp("Mozilla/5.0 (iPhone)",false),false);
});

test("desktop form remembers only identity, suppresses password autofill and clears entered password", () => {
  const page=readFileSync("apps/web/src/pages/PublicPages.tsx","utf8");
  const api=readFileSync("apps/web/src/api.tsx","utf8");
  const storage=readFileSync("apps/web/src/offline-storage.ts","utf8");
  const policy=readFileSync("apps/web/src/device-login-policy.ts","utf8");
  assert.match(page,/useState\(savedLoginIdentifier\)/);
  assert.match(page,/rememberLoginIdentifier\(loginId\)/);
  assert.match(page,/autoComplete=\{allowPasswordAutofill \? undefined : "off"\}/);
  assert.match(page,/autoComplete=\{allowPasswordAutofill\s*\? \(registering \? "new-password" : "current-password"\)\s*: "off"\}/);
  assert.match(page,/readOnly=\{!allowPasswordAutofill && !passwordReady\}/);
  assert.match(page,/setDraft\(current => \(\{\.\.\.current,password:""\}\)\)/);
  assert.match(policy,/alraesy-login-identifier-v1/);
  assert.doesNotMatch(policy,/localStorage\.setItem\([^,]+,\s*password/);
  // Desktop retains an offline salted verifier for explicit password login;
  // it cannot resume the last employee automatically after an offline reload.
  assert.match(api,/if \(!allowPasswordAutofillOnDevice\(\)\)/);
  assert.match(api,/authenticateOfflineAccount\(identity,password\)/);
  assert.match(storage,/OFFLINE_PBKDF2_ITERATIONS = 350_000/);
  assert.match(storage,/crypto\.subtle\.deriveBits/);
});

test("desktop Chrome uses full-width bullet-masked text without native password autofill", () => {
  assert.equal(compactDesktopTextSecret(false, false, true), true);
  assert.equal(compactDesktopTextSecret(false, false, false), false,
    "Unsupported browsers must fall back to a masked native password input");
  assert.equal(compactDesktopTextSecret(true, false, true), false,
    "The installed mobile app continues using its native password input");
  assert.equal(compactDesktopTextSecret(false, true, true), false,
    "Registration keeps a native password input");
  const page = readFileSync("apps/web/src/pages/PublicPages.tsx", "utf8");
  const policy = readFileSync("apps/web/src/device-login-policy.ts", "utf8");
  const style = readFileSync("apps/web/src/styles.css", "utf8");
  assert.match(page,/const desktopTextSecret = compactDesktopTextSecret/);
  assert.match(page,/browserSupportsTextMask\(\)/);
  assert.match(policy,/CSS\.supports\("-webkit-text-security", "disc"\)/);
  assert.match(page,/type=\{desktopTextSecret \? "text" : "password"\}/);
  assert.match(page,/name=\{desktopTextSecret \? "employee-secret-entry" : "password"\}/);
  assert.match(page,/className=\{desktopTextSecret \? "auth-desktop-masked-secret" : ""\}/);
  assert.match(style,/\.field\.auth-desktop-masked-secret input\s*\{/);
  assert.match(style,/width: 100%;/);
  assert.match(style,/-webkit-text-security: disc;/);
});
