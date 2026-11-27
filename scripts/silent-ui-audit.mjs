#!/usr/bin/env node
// Read-only runtime counterpart to silent-health-audit.mjs.
// No sign-in, screenshots, collected user content, or application writes.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

const defaultOrigin = 'https://alraesy-private-preview.onrender.com';
const scope = 'Unauthenticated landing-page runtime only; no account or business-function checks';

async function probe(target, launchOptions, settleMs = 2500) {
  const url = new URL(target);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !['https:', 'http:'].includes(url.protocol)) throw new Error('invalid_origin');

  let browser;
  let phase = 'launch';
  const started = performance.now();
  const report = (result) => ({
    checkedAt: new Date().toISOString(),
    type: 'public_runtime_without_login',
    durationMs: Math.round(performance.now() - started),
    scope,
    ...result,
  });
  try {
    browser = await chromium.launch({ headless: true, timeout: 15000, ...launchOptions });
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let uncaughtErrors = 0;
    page.on('pageerror', () => { uncaughtErrors++; });

    phase = 'navigation';
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    phase = 'inspection';
    await page.waitForTimeout(settleMs);
    const visibleText = await page.locator('body').innerText({ timeout: 5000 });
    const errorBoundaryVisible =
      visibleText.includes('تعذر فتح الصفحة') &&
      visibleText.includes('إعادة فتح الصفحة');
    const hasVisibleApp = visibleText.trim().length > 0;
    const httpStatus = response?.status() ?? null;
    const httpOk = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    const ok = httpOk && hasVisibleApp && !errorBoundaryVisible && uncaughtErrors === 0;
    return report({
      outcome: ok ? 'healthy' : 'page_failed',
      httpStatus, httpOk, hasVisibleApp, errorBoundaryVisible, uncaughtErrors, ok,
    });
  } catch {
    return report({
      outcome: phase === 'launch' ? 'browser_unavailable' : 'check_inconclusive',
      phase,
      httpStatus: null, httpOk: null, hasVisibleApp: null,
      errorBoundaryVisible: null, uncaughtErrors: null, ok: false,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function selfTest(launchOptions) {
  let mode = 'healthy';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(mode === 'healthy'
      ? '<html><body><main>Example app</main></body></html>'
      : '<html><body><main>تعذر فتح الصفحة <button>إعادة فتح الصفحة</button></main></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const localOptions = { ...launchOptions, proxy: undefined };
    assert.equal((await probe(origin, localOptions, 50)).outcome, 'healthy');
    mode = 'error';
    const error = await probe(origin, localOptions, 50);
    assert.equal(error.outcome, 'page_failed');
    assert.equal(error.httpStatus, 200);
    assert.equal(error.errorBoundaryVisible, true);
    const noBrowser = await probe(origin, {
      ...localOptions, executablePath: '/nonexistent-alraesy-probe-browser',
    });
    assert.equal(noBrowser.outcome, 'browser_unavailable');
    assert.equal(noBrowser.errorBoundaryVisible, null);
    return { ok: true, scenarios: 3 };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const browserPath = process.env.ALRAESY_MONITOR_CHROMIUM;
const proxyServer = process.env.ALRAESY_MONITOR_PROXY;
const launchOptions = {
  ...(browserPath ? { executablePath: browserPath } : {}),
  ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
};

try {
  const result = process.argv.includes('--self-test')
    ? await selfTest(launchOptions)
    : await probe(process.env.ALRAESY_MONITOR_ORIGIN || defaultOrigin, launchOptions);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write('runtime_audit_failed: ' +
    (error instanceof Error ? error.name : 'unknown') + '\n');
  process.exitCode = 1;
}
