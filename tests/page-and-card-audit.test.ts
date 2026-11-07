import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Database } from "../apps/api/src/db.ts";
import { audit } from "../apps/api/src/services/audit.ts";
import { pageVisitEventSchema } from "../packages/contracts/src/wallet.ts";
import { auditActionLabels, companyAuditActions, publicAuditActions, type User } from "../packages/contracts/src/index.ts";

const source = (p: string) => readFileSync(p, "utf8");
const user = { id: 18, displayName: "محاسب تجريبي" } as User;

test("page opening and card field changes appear in the audit action directory", () => {
  for (const action of ["page.open", "card.field.update"] as const) {
    assert.ok(auditActionLabels[action]);
    assert.ok(companyAuditActions.includes(action));
    assert.ok(publicAuditActions.includes(action));
  }
  assert.equal(pageVisitEventSchema.parse({
    pageKey: "company.item-card", recordId: 12,
    idempotencyKey: "e27f84c6-0d44-45f3-a8e7-79c1d35e02ac",
  }).recordId, 12);
});

test("a successful card update retains the original event and records real field differences", async () => {
  const writes: { sql: string; values: unknown[] }[] = [];
  const db = { query: async (sql: string, values: unknown[]) => {
    writes.push({ sql, values });
    return { rows: [] };
  } } as unknown as Database;
  await audit(db, user, "account.update", "account", 42,
    { name: "قديم", active: true, revision: 1, passwordHash: "NEVER" },
    { name: "جديد", active: true, revision: 2, passwordHash: "ALSO_NEVER" }, 2);
  assert.equal(writes.length, 2, "one original audit and one batched field-level audit");
  assert.equal(writes[0]?.values[4], "account.update");
  assert.equal(writes[1]?.values[4], "card.field.update");
  assert.deepEqual(JSON.parse(String(writes[1]?.values[7])),
    { field: "name", value: "قديم" });
  assert.deepEqual(JSON.parse(String(writes[1]?.values[8])),
    { field: "name", value: "جديد" });
  assert.equal(JSON.stringify(writes[1]).includes("NEVER"), false);
  assert.equal(JSON.stringify(writes[1]).includes("revision"), false);
});

test("item cards keep their existing item.field.update logic without duplicate generic events", async () => {
  let writes = 0;
  const db = { query: async () => { writes++; return { rows: [] }; } } as unknown as Database;
  await audit(db, user, "item.update", "item", 12,
    { name: "أ" }, { name: "ب" }, 2);
  assert.equal(writes, 1);
});

test("existing page visit event also audits opens when points are disabled", () => {
  const service = source("apps/api/src/services/wallet-page-visit.ts");
  const check = service.indexOf("page?.enabled");
  const auditPos = service.indexOf('"page.open"');
  const points = service.indexOf("const task = await client.query");
  assert.ok(check >= 0 && auditPos > check && points > auditPos);
  const guard = source("apps/web/src/page-directory.tsx");
  assert.match(guard, /reward-events\/page-visit/);
  assert.match(guard, /page-catalog\/visit/);
  const sheet = source("apps/web/src/ItemCardBottomSheetHost.tsx");
  assert.match(sheet, /pageKey: "company.item-card", recordId: itemId/);
});
