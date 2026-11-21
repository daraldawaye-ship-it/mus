import assert from "node:assert/strict";
import test from "node:test";
import { publicRoutes } from "../src/routes-public.ts";
import { defaultUserCategory } from "../../../packages/contracts/src/user-category.ts";

const ownerRow = { id: 1, owner: true, kind: "admin", archived: false, suspended: false,
  created_at: "2026-11-16T00:00:00Z" };
const targetRow = { id: 8, display_name: "اسم اختباري", kind: "member", category: null,
  archived: false, suspended: true, created_at: "2026-11-16T02:00:00Z",
  phone: "private phone", email: "private email", password_hash: "private credential" };

function fixture({ auth = true, owner = true, enabled = true, target = targetRow, id = "8" } = {}) {
  let targetReads = 0;
  const client = { release() {}, async query(sql, args) {
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    if (/^SELECT \* FROM users WHERE id/.test(sql)) {
      assert.deepEqual(args, [1]);
      return { rows: [{ ...ownerRow, owner }] };
    }
    if (/^SELECT \* FROM page_settings/.test(sql)) {
      return { rows: enabled ? [] : [{ company_id: null, page_key: "public.users", enabled: false }] };
    }
    if (/FROM (page_access_grants|explanation_groups|general_table_grants|legal_case_access)/.test(sql))
      return { rows: [] };
    if (/FROM users WHERE id=\$1$/.test(sql)) {
      assert.equal(sql, "SELECT id, display_name, kind, category, archived, suspended, created_at FROM users WHERE id=$1");
      assert.deepEqual(args, [8]);
      targetReads++;
      return { rows: target ? [target] : [] };
    }
    throw new Error("Unexpected query in test: " + sql);
  } };
  const entry = publicRoutes({ connect: async () => client }).stack.find(
    ({ route }) => route?.path === "/users/:id/dock-card" && route?.methods.get,
  );
  assert.ok(entry);
  const req = { params: { id }, auth: auth ? { user: { id: 1, owner: true } } : undefined };
  return { get targetReads() { return targetReads; }, run: () => new Promise((resolve, reject) => {
    entry.route.stack[0].handle(req, { json: resolve }, reject);
  }) };
}

test("only fresh owner with enabled public.users can query an exact target", async () => {
  for (const [input, status] of [[{ auth: false }, 401], [{ owner: false }, 403], [{ enabled: false }, 403], [{ id: "08" }, 400]]) {
    const testApi = fixture(input);
    await assert.rejects(testApi.run(), error => error.status === status);
    assert.equal(testApi.targetReads, 0);
  }
});

test("response contains only allowed fields and missing exact ID returns 404", async () => {
  const testApi = fixture();
  assert.deepEqual(await testApi.run(), { user: {
    id: 8, displayName: "اسم اختباري", kind: "member", category: defaultUserCategory,
    archived: false, suspended: true, createdAt: "2026-11-16T02:00:00.000Z",
  } });
  assert.equal(testApi.targetReads, 1);
  await assert.rejects(fixture({ target: null }).run(), error => error.status === 404);
});
