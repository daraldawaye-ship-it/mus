import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appShellBuildFingerprint } from "../apps/web/src/app-update-version.ts";

const shell = (js: string, css: string) =>
  '<html><head><script type="module" src="/assets/' + js + '.js"></script>' +
  '<link rel="stylesheet" href="/assets/' + css + '.css"></head></html>';

test("compares entry JS and CSS from original page to freshly served build", () => {
  const current = appShellBuildFingerprint(shell("main-a", "main-c"));
  assert.equal(current, "/assets/main-a.js|/assets/main-c.css");
  assert.equal(appShellBuildFingerprint(shell("main-a", "main-c")), current);
  assert.notEqual(appShellBuildFingerprint(shell("main-b", "main-c")), current);
  assert.notEqual(appShellBuildFingerprint(shell("main-a", "main-d")), current);
  assert.equal(appShellBuildFingerprint("<html><body>Service unavailable</body></html>"), null);
  assert.equal(appShellBuildFingerprint('<img src="/assets/logo.png">'), null);
  assert.equal(appShellBuildFingerprint(
    '<script src="/assets/main-a.js?v=2"></script><link href="/assets/main-c.css#x">',
  ), current);
});

test("checks a static uncached build at low frequency, respecting offline and active drafts", () => {
  const source = readFileSync("apps/web/src/AppUpdatePrompt.tsx", "utf8");
  assert.match(source, /alraesy-update-check/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /isOfflineNow\(\)/);
  assert.match(source, /120_000/);
  assert.match(source, /document.visibilityState === "hidden"/);
  assert.match(source, /alraesy-network-restored/);
  assert.match(source, /window.confirm\(/);
  assert.match(source, /refreshEntireApp\(\)/);
  assert.match(source, /setDismissed\(available\)/);
  assert.doesNotMatch(source, /localStorage\.clear|indexedDB\.deleteDatabase|caches\.delete/);
});

test("bottom update banner does not remove the manually available full-refresh action", () => {
  const css = readFileSync("apps/web/src/styles.css", "utf8");
  const shellSource = readFileSync("apps/web/src/App.tsx", "utf8");
  const manual = readFileSync("apps/web/src/UserMenu.tsx", "utf8");
  assert.match(css, /\.app-update-prompt\s*\{[^}]*position:\s*fixed;[^}]*bottom:/s);
  assert.match(css, /@media print\s*\{\s*\.app-update-prompt\s*\{\s*display:\s*none/);
  assert.match(shellSource, /<AppUpdatePrompt \/>/);
  assert.match(manual, /refreshEntireApp/);
  assert.match(manual, /تحديث شامل/);
});
