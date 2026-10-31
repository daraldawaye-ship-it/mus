import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("an installed Alraesy PWA can receive an in-scope deep link in an existing app window", () => {
  const manifest = JSON.parse(readFileSync("apps/web/public/site.webmanifest", "utf8"));
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.launch_handler?.client_mode, "navigate-existing");
});

test("the manifest link and browser client-side router preserve deep links to company pages", () => {
  const html = readFileSync("apps/web/index.html", "utf8");
  const entry = readFileSync("apps/web/src/main.tsx", "utf8");
  const app = readFileSync("apps/web/src/App.tsx", "utf8");
  assert.match(html, /rel="manifest" href="\/site\.webmanifest"/);
  assert.match(entry, /createBrowserRouter/);
  assert.match(entry, /path: "\*"/);
  assert.match(app, /ItemOptionsListPage/);
});

test("incoming HTTPS PWA deep links do not require a custom scheme or an external redirect", () => {
  const manifest = JSON.parse(readFileSync("apps/web/public/site.webmanifest", "utf8"));
  assert.equal(manifest.protocol_handlers, undefined);
  assert.equal(manifest.capture_links, undefined); // obsolete, nonstandard manifest member
  assert.equal(manifest.scope, "/");
});
