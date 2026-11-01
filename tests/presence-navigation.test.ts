import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { pageByKey, pageHref, pageKeyForLocation } from "../packages/contracts/src/pages.ts";

test("both pages are separate and discoverable in the registered navigation", () => {
  const general = pageByKey("public.last-present");
  assert.ok(general, "last-present users must be registered");
  assert.equal(general.name, "آخر المتواجدين");
  assert.equal(general.navigation, true);
  assert.equal(general.scope, "public");
  assert.equal(general.parentKey, "public.users");
  assert.equal(general.actions.view?.role, "public-admin");
  assert.equal(pageHref(general), "/users/last-present");
  assert.equal(pageKeyForLocation("/users/last-present", ""), general.key);

  const company = pageByKey("company.attendance-current");
  assert.ok(company, "company attendance-current must be registered");
  assert.equal(company.name, "المحضرون حاليًا");
  assert.equal(company.navigation, true);
  assert.equal(company.scope, "company");
  assert.equal(company.parentKey, "company.attendance");
  assert.equal(company.actions.view?.role, "company-general");
  assert.equal(pageHref(company, 2), "/companies/2/attendance-current");
  assert.equal(pageKeyForLocation("/companies/2/attendance-current", ""), company.key);
});

test("both the public and company dedicated routes are connected to the UI", () => {
  const app = readFileSync("apps/web/src/App.tsx", "utf8");
  const migration = readFileSync("apps/api/migrations/20261102_register_presence_pages.sql", "utf8");
  assert.match(app, /"public.last-present": <FileClock/);
  assert.match(app, /"company.attendance-current": <Users/);
  assert.match(app, /"attendance-current",/);
  assert.match(app, /case "attendance-current":/);
  assert.match(app, /<AttendanceCurrentlyPresent companyId=\{context.company.id\}/);
  assert.match(app, /pageKey="public.last-present"/);
  assert.match(migration, /\('public.last-present'\)/);
  assert.match(migration, /\('company.attendance-current'\)/);
});
