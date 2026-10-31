import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_APPEARANCE } from "../packages/contracts/src/index.ts";
import { buildThemeTokens } from "../apps/web/src/theme.tsx";

test("site and company appearance defaults use dark mode", () => {
  assert.equal(DEFAULT_APPEARANCE.mode, "dark");
  assert.equal(buildThemeTokens(DEFAULT_APPEARANCE.mode, DEFAULT_APPEARANCE.color)["--bg"], "#111a22");
  assert.equal(buildThemeTokens(DEFAULT_APPEARANCE.mode, DEFAULT_APPEARANCE.color)["--surface"], "#1a2631");
});

test("HTML paints dark before React and PWA splash is dark", () => {
  const html = readFileSync("apps/web/index.html", "utf8");
  const manifest = JSON.parse(readFileSync("apps/web/public/site.webmanifest", "utf8"));
  assert.match(html, /<html[^>]+data-theme="dark"/);
  assert.match(html, /background:\s*#111a22/);
  assert.match(html, /name="theme-color" content="#111a22"/);
  assert.equal(manifest.background_color, "#111a22");
  assert.equal(manifest.theme_color, "#111a22");
});

test("existing light appearance migration keeps users' accent colors", () => {
  const sql = readFileSync(
    "apps/api/migrations/20261101_default_dark_appearance_all_users.sql", "utf8",
  );
  assert.match(sql, /UPDATE appearance/);
  assert.match(sql, /SET mode = 'dark'/);
  assert.match(sql, /WHERE mode = 'light'/);
  assert.doesNotMatch(sql, /SET\s+color/);
});
