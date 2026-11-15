import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const shellName = "alraesy-static-offline-20261030-v5";
const oldJs = "/assets/index-old.js";
const newJs = "/assets/index-new.js";
const commerce = "/assets/CommercePages-new.js";
const finance = "/assets/FinancePages-new.js";
const oldHtml = `<script src="${oldJs}"></script>`;
const newHtml = `<script src="${newJs}"></script>`;

function workerHarness() {
  const shell = new Map<string, Response>([
    ["/", new Response(oldHtml, { headers: { "content-type": "text/html" } })],
    [oldJs, new Response("old")],
  ]);
  const entries = new Map([[shellName, shell]]);
  const caches = {
    async open(name: string) {
      if (!entries.has(name)) entries.set(name, new Map());
      const cache = entries.get(name)!;
      return {
        async match(path: string) { return cache.get(path)?.clone(); },
        async put(path: string, response: Response) { cache.set(path, response.clone()); },
        async add() {},
      };
    },
    async delete(name: string) { return entries.delete(name); },
  };
  let offline = false;
  let missingAsset = false;
  let skipped = false;
  const handlers: Record<string, (event: any) => void> = {};
  const self = {
    addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler; },
    location: { origin: "https://example.test" },
    skipWaiting: async () => { skipped = true; },
  };
  const fetch = async (path: string) => {
    if (offline) throw Error("offline");
    if (path === "/offline-assets.json") return Response.json([newJs, commerce, finance]);
    if (path === finance && missingAsset) return new Response("", { status: 404 });
    if ([newJs, commerce, finance].includes(path)) {
      return new Response("new JS", { headers: { "content-type": "application/javascript" } });
    }
    return new Response(newHtml, { headers: { "content-type": "text/html" } });
  };
  const script = readFileSync(new URL("../apps/web/public/push-sw.js", import.meta.url), "utf8");
  runInNewContext(script, { self, caches, fetch, URL, Response });
  return {
    handlers, entries,
    failAsset: () => { missingAsset = true; },
    goOffline: () => { offline = true; },
    skipped: () => skipped,
  };
}

function install(handlers: ReturnType<typeof workerHarness>["handlers"]): Promise<unknown> {
  let work: Promise<unknown> | undefined;
  handlers.install({ waitUntil: (value: Promise<unknown>) => { work = value; } });
  assert.ok(work);
  return work;
}

function offlineNavigate(handlers: ReturnType<typeof workerHarness>["handlers"]): Promise<Response> {
  let response: Promise<Response> | undefined;
  handlers.fetch({
    request: { url: "https://example.test/", method: "GET", mode: "navigate" },
    waitUntil: () => {},
    respondWith: (value: Promise<Response>) => { response = value; },
  });
  assert.ok(response);
  return response;
}

test("failed worker upgrade preserves prior offline navigation and hashed asset", async () => {
  const worker = workerHarness();
  worker.failAsset();
  await assert.rejects(install(worker.handlers), /Static asset unavailable/);
  assert.equal(worker.skipped(), false);
  assert.ok(worker.entries.get(shellName)?.has(oldJs));
  worker.goOffline();
  const response = await offlineNavigate(worker.handlers);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), oldHtml);
});

test("successful install publishes the complete new shell and leaves APIs alone", async () => {
  const worker = workerHarness();
  await install(worker.handlers);
  assert.equal(worker.skipped(), true);
  for (const path of [newJs, commerce, finance]) assert.ok(worker.entries.get(shellName)?.has(path));
  worker.goOffline();
  assert.equal(await (await offlineNavigate(worker.handlers)).text(), newHtml);
  for (const [url, method] of [
    ["https://example.test/api/session", "GET"], ["https://example.test/api/invoices", "POST"],
  ]) {
    worker.handlers.fetch({
      request: { url, method, mode: "cors" },
      waitUntil: () => assert.fail("worker should not wait on API requests"),
      respondWith: () => assert.fail("worker should not intercept API requests"),
    });
  }
});

test("startup sends a warm signal when the worker update check rejects", async () => {
  const messages: unknown[] = [];
  let updateCalls = 0;
  const registration = {
    active: { postMessage: (message: unknown) => { messages.push(message); } },
    update: async () => { updateCalls++; throw Error("update unavailable"); },
  };
  const descriptors = Object.fromEntries(["window", "document", "navigator"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const setGlobal = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    setGlobal("window", {
      isSecureContext: true,
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener() {},
    });
    setGlobal("document", { visibilityState: "visible", addEventListener() {} });
    setGlobal("navigator", {
      onLine: true,
      serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) },
    });
    const { prepareInstall } = await import("../apps/web/src/app-install.ts");
    prepareInstall();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(updateCalls, 1);
    assert.deepEqual(messages, [{ type: "alraesy:warm-static" }]);
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
