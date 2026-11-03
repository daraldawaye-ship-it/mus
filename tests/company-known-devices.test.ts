import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pageByKey } from "../packages/contracts/src/pages.ts";
import { summarizeDeviceAgent } from "../apps/api/src/routes-company-devices.ts";

const source = readFileSync("apps/api/migrations/20261103_company_known_devices.sql", "utf8");
test("device registry is company-isolated with a hashed installation key", () => {
  assert.match(source, /UNIQUE\s*\(company_id,\s*identity_hash\)/);
  assert.match(source, /REFERENCES companies\(id\)/);
  assert.match(source, /company_known_device_users/);
  assert.doesNotMatch(source, /password|ip_address|latitude|longitude/i);
});

test("approved-devices is a registered company page and not a login permission", () => {
  const page = pageByKey("company.approved-devices");
  assert.equal(page?.scope, "company");
  assert.equal(page?.route, "/companies/:companyId/approved-devices");
  assert.equal(page?.actions.view?.role, "company-general");
  assert.equal(page?.actions.edit?.role, "company-general");
});

test("user agent display classification is informational", () => {
  assert.deepEqual(
    summarizeDeviceAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36"),
    { browser: "Chrome", os: "Windows" },
  );
  assert.deepEqual(
    summarizeDeviceAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) FxiOS/130.0"),
    { browser: "Firefox", os: "iOS / iPadOS" },
  );
  assert.deepEqual(summarizeDeviceAgent(""), { browser: "متصفح غير معروف", os: "غير معروف" });
});
