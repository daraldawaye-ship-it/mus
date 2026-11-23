#!/usr/bin/env node
// Optional runtime counterpart to silent-health-audit.mjs.
// Read-only, no sign-in, no screenshots, no collected user content, no writes.
import { chromium } from 'playwright';
import { performance } from 'node:perf_hooks';

const target = process.env.ALRAESY_MONITOR_ORIGIN ||
  'https://alraesy-private-preview.onrender.com';
const url = new URL(target);
if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !['https:', 'http:'].includes(url.protocol)) throw new Error('invalid_origin');

let browser;
const started = performance.now();
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    serviceWorkers: 'block',
    acceptDownloads: false,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  let uncaughtErrors = 0;
  page.on('pageerror', () => { uncaughtErrors++; });

  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2500);
  const visibleText = await page.locator('body').innerText({ timeout: 5000 });
  const errorBoundaryVisible =
    visibleText.includes('تعذر فتح الصفحة') &&
    visibleText.includes('إعادة فتح الصفحة');
  const hasVisibleApp = visibleText.trim().length > 0;
  const status = response?.status() ?? null;
  const httpOk = status !== null && status >= 200 && status < 300;
  const report = {
    checkedAt: new Date().toISOString(),
    type: 'public_runtime_without_login',
    httpStatus: status,
    httpOk,
    hasVisibleApp,
    errorBoundaryVisible,
    uncaughtErrors,
    durationMs: Math.round(performance.now() - started),
    ok: httpOk && hasVisibleApp && !errorBoundaryVisible && uncaughtErrors === 0,
    scope: 'Unauthenticated landing-page runtime only; no account or business-function checks',
  };
  process.stdout.write(JSON.stringify(report) + '\n');
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write('runtime_audit_failed: ' +
    (error instanceof Error ? error.name : 'unknown') + '\n');
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
