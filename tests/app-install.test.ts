import assert from "node:assert/strict";
import test from "node:test";

// Exercise the real install controller without a browser or React dependency.
// No stored marker is allowed to claim installation after a browser visit.
const events = new EventTarget();
const browser = Object.assign(events, {
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  isSecureContext: true,
});
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
const install = await import("../apps/web/src/app-install.ts");

test("manual instructions cover iPad desktop mode, Firefox, and embedded browsers", () => {
  assert.equal(install.appleMobile("Mozilla iPhone", "iPhone", 5), true);
  assert.equal(install.appleMobile("Mozilla Macintosh", "MacIntel", 5), true);
  assert.equal(install.appleMobile("Mozilla Macintosh", "MacIntel", 0), false);
  assert.match(install.installInstructions(true, ""), /المشاركة/);
  assert.match(install.installInstructions(true, "Instagram"), /فتح في المتصفح/);
  assert.match(install.installInstructions(false, "Mozilla Android Firefox/140"), /Firefox/);
  assert.match(install.installInstructions(false, "Mozilla Android; wv)"), /فتح في المتصفح/);
  assert.match(install.installInstructions(false, "WhatsApp/2"), /فتح في المتصفح/);
});

test("early install event remains available, uses one click, and accepted choice is not installation", async () => {
  let prompts = 0;
  let observed = 0;
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt() { prompts++; return Promise.resolve(); },
    userChoice: Promise.resolve({ outcome: "accepted" as const }),
  });
  browser.dispatchEvent(event);
  // The event arrived before the UI subscribed. No native dialog was invoked.
  assert.equal(event.defaultPrevented, true);
  assert.equal(prompts, 0);
  assert.equal(install.installSnapshot().prompt, event);
  const stop = install.observeInstall(() => observed++);
  const request = install.requestInstall();
  assert.equal(prompts, 1, "prompt must run synchronously from the click");
  await request;
  assert.equal(install.installSnapshot().prompt, null);
  assert.equal(install.installSnapshot().installed, false);
  assert.match(install.installSnapshot().message, /أكمل تثبيت/);
  await install.requestInstall();
  assert.equal(prompts, 1, "consumed event must not be reused");
  assert.ok(observed > 0);
  stop();
});

test("dismissal retains visible manual guidance and a failed prompt can recover", async () => {
  browser.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), {
    prompt: () => Promise.resolve(),
    userChoice: Promise.resolve({ outcome: "dismissed" as const }),
  }));
  await install.requestInstall();
  assert.equal(install.installSnapshot().installed, false);
  assert.match(install.installSnapshot().message, /لم يكتمل/);
  browser.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), {
    prompt: () => { throw new Error("not supported now"); },
    userChoice: Promise.resolve({ outcome: "dismissed" as const }),
  }));
  await install.requestInstall();
  assert.equal(install.installSnapshot().busy, false);
  assert.equal(install.installSnapshot().prompt, null);
  assert.match(install.installSnapshot().message, /تعذر/);
});

test("only observed appinstalled completes install setup", () => {
  browser.dispatchEvent(new Event("appinstalled"));
  assert.equal(install.installSnapshot().installed, true);
  assert.equal(install.installSnapshot().prompt, null);
});
