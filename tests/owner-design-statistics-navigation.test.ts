import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { pageByKey, pageDefinitions, pageHref, pageKeyForLocation, type User } from "../packages/contracts/src/index.ts";
import { directoryEntries, assertDirectoryAccess } from "../apps/api/src/services/pages.ts";
import type { Database } from "../apps/api/src/db.ts";

const cases = [
  { key: "public.design-library", route: "/design-library", name: "مكتبة التصاميم" },
  { key: "public.interest-statistics", route: "/interest-statistics", name: "إحصاءات اهتمامات الزوار" },
] as const;
const user = (owner: boolean, kind: string) => ({ id: 7, owner, kind, suspended: false }) as User;
const db = { query: async (sql: string) => {
  const rows = sql.includes("FROM page_access_grants")
    ? cases.map(({key}) => ({
        page_key: key, company_id: null, action: "view",
        principal_type: "user", principal_value: "7", effect: "allow",
      }))
    : [];
  return { rows, rowCount: rows.length };
} } as unknown as Database;

test("existing owner pages have one canonical public directory entry and resolve to the dock key", () => {
  for (const { key, route, name } of cases) {
    const entry = pageByKey(key);
    assert.ok(entry);
    assert.equal(entry.name, name);
    assert.equal(entry.scope, "public");
    assert.equal(entry.navigation, true);
    assert.equal(pageHref(entry, 2), route);
    assert.equal(pageDefinitions.filter(entry => entry.route === route).length, 1);
    assert.equal(pageKeyForLocation(route + "/", "?unused=1"), key);
  }
  assert.equal(pageKeyForLocation("/design-library/layout", ""), cases[0].key);
  assert.equal(pageKeyForLocation("/design-library/layout/bad", ""), undefined);
});

test("owner can resolve both page cards; generic grants cannot expose them to non-owners", async () => {
  for (const [owner, kind] of [[true, "admin"], [false, "admin"], [false, "member"]] as const) {
    const entries = await directoryEntries(db, user(owner, kind), null);
    for (const {key} of cases) {
      const entry = entries.find(entry => entry.key === key)!;
      assert.equal(entry.actionAccess.view, owner);
      if (owner) assert.doesNotThrow(() => assertDirectoryAccess(entry));
      else assert.throws(() => assertDirectoryAccess(entry));
    }
  }
});

test("direct protected routes keep their mode restrictions and use the catalog instead of duplicate links", async () => {
  const source = await readFile(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<NavLink to="\/(?:design-library|interest-statistics)"/);
  for (const { key, route } of cases) {
    const line = source.split(`path="${route}"`)[1]?.split("</Protected>")[0] ?? "";
    assert.match(line, /user\?\.owner/);
    assert.ok(line.includes("!employeePreview"));
    if (route === "/interest-statistics") assert.ok(line.includes("!visitorOnly"));
    assert.ok(line.includes(`pageKey="${key}" trackVisit={false}`));
  }
});
