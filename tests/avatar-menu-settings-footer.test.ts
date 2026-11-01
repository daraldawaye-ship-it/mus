import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const menu = readFileSync("apps/web/src/UserMenu.tsx", "utf8");
const style = readFileSync("apps/web/src/user-menu-tabs.css", "utf8");
const refresh = readFileSync("apps/web/src/app-force-refresh.ts", "utf8");

test("avatar menu has a slim always-visible settings footer, no swipe hint", () => {
  assert.doesNotMatch(menu, /اسحب لأسفل لعرض المزيد من خيارات القسم/);
  const footerStart = menu.indexOf('className="user-menu-tabs-footer user-menu-settings-actions"');
  assert.ok(footerStart >= 0);
  const footer = menu.slice(footerStart, menu.indexOf("</div>", footerStart));
  for (const label of ["تعديل حسابي", "المظهر", "اتصالات ChatGPT", "تسجيل الخروج", "تحديث شامل"]) {
    assert.ok(footer.includes(label), label);
  }
  assert.ok(footer.indexOf("تسجيل الخروج") < footer.indexOf("تحديث شامل"));
  assert.match(style, /\.user-menu-tabs-footer\.user-menu-settings-actions[\s\S]*?height: 38px;/);
  assert.match(style, /\.user-menu-settings-actions > \.user-menu-tile[\s\S]*?height: 38px;/);
});

test("full refresh requests fresh app HTML and updates PWA without deleting offline drafts", () => {
  assert.match(menu, /refreshEntireApp\(\)/);
  assert.match(menu, /window\.confirm\(/);
  assert.match(refresh, /cache: "no-store"/);
  assert.match(refresh, /credentials: "same-origin"/);
  assert.match(refresh, /serviceWorker\.getRegistration\(\)/);
  assert.match(refresh, /registration\.update\(\)/);
  assert.match(refresh, /alraesy-fresh/);
  assert.match(refresh, /window\.location\.replace\(target\.href\)/);
  assert.doesNotMatch(refresh, /caches\.delete|indexedDB\.deleteDatabase|localStorage\.clear|sessionStorage\.clear/);
});
