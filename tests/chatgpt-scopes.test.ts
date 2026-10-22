import assert from "node:assert/strict";
import test from "node:test";
import {
  API_READ_SCOPE,
  API_WRITE_SCOPE,
  SITE_READ_SCOPE,
  SITE_WRITE_SCOPE,
  FULL_READ_SCOPE,
  FULL_WRITE_SCOPE,
  oauthScopes,
  scopeIncludes,
  scopeRequiresPublicAdmin,
  canReadGeneralTable,
} from "../apps/api/src/services/mcp-api.ts";

test("site-only scopes permit employee access without general table access", () => {
  const employee = { owner: false, kind: "member" } as const;
  assert.equal(SITE_READ_SCOPE, API_READ_SCOPE);
  assert.equal(SITE_WRITE_SCOPE, API_READ_SCOPE + " " + API_WRITE_SCOPE);
  assert.ok(oauthScopes.includes(SITE_READ_SCOPE));
  assert.ok(oauthScopes.includes(SITE_WRITE_SCOPE));
  assert.equal(scopeRequiresPublicAdmin(SITE_READ_SCOPE), false);
  assert.equal(scopeRequiresPublicAdmin(SITE_WRITE_SCOPE), false);
  assert.equal(scopeIncludes(SITE_READ_SCOPE, API_WRITE_SCOPE), false);
  assert.equal(scopeIncludes(SITE_WRITE_SCOPE, API_WRITE_SCOPE), true);
  assert.equal(canReadGeneralTable(SITE_READ_SCOPE, employee), false);
  assert.equal(canReadGeneralTable(SITE_WRITE_SCOPE, employee), false);
});

test("global general table requires both its OAuth scope and administrator", () => {
  const employee = { owner: false, kind: "supervisor" } as const;
  const admin = { owner: false, kind: "admin" } as const;
  const owner = { owner: true, kind: "member" } as const;
  assert.equal(scopeRequiresPublicAdmin(FULL_READ_SCOPE), true);
  assert.equal(scopeRequiresPublicAdmin(FULL_WRITE_SCOPE), true);
  assert.equal(canReadGeneralTable(FULL_READ_SCOPE, employee), false);
  assert.equal(canReadGeneralTable(FULL_WRITE_SCOPE, employee), false);
  assert.equal(canReadGeneralTable(SITE_WRITE_SCOPE, owner), false);
  assert.equal(canReadGeneralTable(FULL_READ_SCOPE, admin), true);
  assert.equal(canReadGeneralTable(FULL_WRITE_SCOPE, owner), true);
  assert.equal(scopeIncludes("general_table.read", API_READ_SCOPE), false);
});

test("scope token checks use whole whitespace-separated names", () => {
  assert.equal(scopeIncludes("tijara.read-extra", API_READ_SCOPE), false);
  assert.equal(scopeIncludes("general_table.read  tijara.read", API_READ_SCOPE), true);
  assert.equal(scopeIncludes("general_table.read\ntijara.read", API_READ_SCOPE), true);
});
