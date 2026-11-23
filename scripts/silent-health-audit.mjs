#!/usr/bin/env node
// Read-only external health audit. No credentials, database access, or writes.
// Intended for a bounded invocation by AI task #1286; no parallel scheduler.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

const defaultOrigin = 'https://alraesy-private-preview.onrender.com';
const timeoutMs = 8000;
const statusOk = (status) => status >= 200 && status < 300;

async function request(origin, path, method = 'GET') {
  const url = new URL(path, origin);
  if (url.origin !== origin.origin) throw new Error('cross_origin_not_allowed');
  const started = performance.now();
  const res = await fetch(url, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Alraesy-Silent-Health-Audit/1.0', 'Cache-Control': 'no-cache' },
  });
  return { res, durationMs: Math.round(performance.now() - started) };
}

export async function auditSiteHealth(base = defaultOrigin) {
  const origin = new URL(base);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('invalid_origin');
  }
  const results = [];
  let assetPath = null;
  const run = async (name, path, method, verify) => {
    try {
      const { res, durationMs } = await request(origin, path, method);
      const verdict = await verify(res);
      results.push({ name, ok: statusOk(res.status) && verdict.ok, status: res.status,
        durationMs, reason: verdict.ok ? null : verdict.reason });
      return results.at(-1).ok;
    } catch (error) {
      results.push({ name, ok: false, status: null, durationMs: null,
        reason: error instanceof Error ? error.name : 'request_failed' });
      return false;
    }
  };

  await run('api_health', '/api/health', 'GET', async (res) => {
    if (!statusOk(res.status)) return { ok: false, reason: 'http_status' };
    const body = await res.json().catch(() => null);
    return { ok: body?.ok === true, reason: 'health_payload_not_ok' };
  });

  await run('public_html', '/', 'GET', async (res) => {
    if (!statusOk(res.status)) return { ok: false, reason: 'http_status' };
    if (!res.headers.get('content-type')?.includes('text/html'))
      return { ok: false, reason: 'unexpected_content_type' };
    const html = await res.text();
    if (html.length > 1024 * 1024 || !/<html\b/i.test(html))
      return { ok: false, reason: 'html_missing_or_oversized' };
    const match = html.match(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.js(?:\?[^"']*)?)["']/i);
    if (!match) return { ok: false, reason: 'script_asset_missing' };
    const asset = new URL(match[1], origin);
    if (asset.origin !== origin.origin) return { ok: false, reason: 'external_script_asset' };
    assetPath = asset.pathname + asset.search;
    return { ok: true };
  });

  if (assetPath) {
    await run('public_js_asset', assetPath, 'HEAD', async (res) => ({
      ok: statusOk(res.status) && /javascript|ecmascript/.test(res.headers.get('content-type') || ''),
      reason: 'asset_missing_or_not_javascript',
    }));
  } else {
    results.push({ name: 'public_js_asset', ok: false, status: null,
      durationMs: null, reason: 'not_discovered' });
  }

  const passed = results.filter((entry) => entry.ok).length;
  return {
    checkedAt: new Date().toISOString(),
    checks: results,
    passed,
    total: results.length,
    successRate: passed / results.length,
    ok: passed === results.length,
    scope: 'Public endpoints only; excludes database, login, and business-process health',
  };
}

async function selfTest() {
  let brokenAsset = false;
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><head></head><body><script type="module" src="/assets/app.js"></script></body></html>');
    } else if (req.url === '/assets/app.js') {
      res.writeHead(brokenAsset ? 404 : 200, { 'Content-Type': 'application/javascript' });
      res.end(req.method === 'HEAD' ? undefined : 'export {};');
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const healthy = await auditSiteHealth(base);
    assert.equal(healthy.passed, 3);
    brokenAsset = true;
    const degraded = await auditSiteHealth(base);
    assert.equal(degraded.passed, 2);
    assert.equal(degraded.checks.find((x) => x.name === 'public_js_asset')?.ok, false);
    return { ok: true, scenarios: 2, checksPerScenario: 3 };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const selfTesting = process.argv.includes('--self-test');
  try {
    const report = selfTesting ? await selfTest() :
      await auditSiteHealth(process.env.ALRAESY_MONITOR_ORIGIN || defaultOrigin);
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`audit_failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exitCode = 1;
  }
}
