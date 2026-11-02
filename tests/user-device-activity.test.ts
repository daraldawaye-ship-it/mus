import assert from "node:assert/strict";
import test from "node:test";
import { classifyDevice } from "../apps/api/src/services/user-device-activity.ts";

const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

test("browser tabs are not mistaken for installed apps", () => {
  assert.equal(classifyDevice(desktop), "desktop_browser");
  assert.equal(classifyDevice(android), "mobile_browser");
  assert.equal(classifyDevice(iphone), "mobile_browser");
});

test("standalone device hints are checked against the platform", () => {
  assert.equal(classifyDevice(android, "android_app"), "android_app");
  assert.equal(classifyDevice(iphone, "iphone_app"), "iphone_app");
  assert.equal(classifyDevice(desktop, "android_app"), "desktop_browser");
  assert.equal(classifyDevice(android, "iphone_app"), "mobile_browser");
  assert.equal(classifyDevice(iphone, "android_app"), "mobile_browser");
});
