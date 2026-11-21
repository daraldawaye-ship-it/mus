import test from "node:test";
import assert from "node:assert/strict";
import {
  companyOverviewHiddenPageKeys, setCompanyOverviewPageVisibility,
} from "../src/services/company-overview-page-visibility.ts";

function fakeDb() {
  const hiddenByCompany = new Map();
  const registry = new Set();
  let reads = 0;
  return { get reads() { return reads; }, async query(sql, args) {
    if (sql.startsWith("INSERT INTO page_registry")) {
      registry.add(args[0]);
      return { rowCount: 1 };
    }
    const [company, key] = args;
    const hidden = hiddenByCompany.get(company) ?? new Set();
    hiddenByCompany.set(company, hidden);
    if (sql.startsWith("SELECT")) {
      reads++;
      assert.match(sql, /WHERE company_id=\$1$/);
      return { rows: [...hidden].map(page_key => ({ page_key })) };
    }
    if (sql.startsWith("INSERT INTO company_overview_hidden_pages")) {
      assert.ok(registry.has(key));
      const existed = hidden.has(key);
      hidden.add(key);
      return { rowCount: existed ? 0 : 1 };
    }
    if (sql.startsWith("DELETE FROM company_overview_hidden_pages")) {
      assert.match(sql, /WHERE company_id=\$1 AND page_key=\$2$/);
      return { rowCount: hidden.delete(key) ? 1 : 0 };
    }
    throw new Error("Unexpected SQL: " + sql);
  } };
}

test("overview defaults to shown, including unscoped public directory", async () => {
  const db = fakeDb();
  assert.equal((await companyOverviewHiddenPageKeys(db, null)).size, 0);
  assert.equal(db.reads, 0);
  assert.equal((await companyOverviewHiddenPageKeys(db, 2)).size, 0);
});

test("public and company page overrides do not cross company boundaries", async () => {
  const db = fakeDb();
  assert.equal(await setCompanyOverviewPageVisibility(db, 2, "public.tasks", false), true);
  assert.equal(await setCompanyOverviewPageVisibility(db, 2, "company.items", false), true);
  assert.equal(await setCompanyOverviewPageVisibility(db, 3, "public.tasks", false), true);
  assert.equal(await setCompanyOverviewPageVisibility(db, 2, "company.items", false), false);
  assert.deepEqual([...(await companyOverviewHiddenPageKeys(db, 2))], ["public.tasks", "company.items"]);
  assert.deepEqual([...(await companyOverviewHiddenPageKeys(db, 3))], ["public.tasks"]);
  assert.equal((await companyOverviewHiddenPageKeys(db, null)).size, 0);
  assert.equal(await setCompanyOverviewPageVisibility(db, 2, "public.tasks", true), true);
  assert.equal(await setCompanyOverviewPageVisibility(db, 2, "public.tasks", true), false);
  assert.deepEqual([...(await companyOverviewHiddenPageKeys(db, 2))], ["company.items"]);
  assert.deepEqual([...(await companyOverviewHiddenPageKeys(db, 3))], ["public.tasks"]);
});
