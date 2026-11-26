import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { listMedaweeItems } from "../apps/api/src/market-medawee-items.ts";
import { createMarketApp } from "../apps/api/src/market/app.ts";
import { signMarketRequest } from "../apps/api/src/market/transport.ts";
import { medicineMarketRoutes } from "../apps/api/src/routes-medicine-market.ts";
import { apiCatalog } from "../apps/api/src/services/mcp-api.ts";

test("Medawee item intake is owner-only, atomic, idempotent, evidenced, and preserves old prices", async () => {
  const db = await PGlite.create();
  const migration = async (name: string) => db.exec(await readFile(
    new URL("../apps/api/market-migrations/" + name, import.meta.url), "utf8",
  ));
  const secret = "test-only-market-secret-".repeat(3);
  const owner = { id: 1, displayName: "Owner", kind: "admin", owner: true, archived: false,
    suspended: false, editor: false, monitor: false } as User;
  const pool = { query: db.query.bind(db), connect: async () => ({ query: db.query.bind(db), release() {} }) } as unknown as Pool;
  const catalog = apiCatalog(medicineMarketRoutes(pool), { filter: "medawee-items" });
  assert.deepEqual(catalog.operations, [
    { operation: "GET /medicine-market/staging/medawee-items", tool: "tijara_api_read" },
    { operation: "POST /medicine-market/staging/medawee-items", tool: "tijara_api_write" },
    { operation: "PATCH /medicine-market/staging/medawee-items", tool: "tijara_api_write" },
  ]);
  const server = createMarketApp(pool, secret).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const path = "/api/medicine-market/staging/medawee-items";
  async function req(method: string, user: User | null, input?: object, query = "") {
    const body = input ? JSON.stringify(input) : "", route = path + query;
    return fetch("http://127.0.0.1:" + address.port + route, {
      method, body: input ? body : undefined,
      headers: { "content-type": "application/json", ...signMarketRequest(secret, method, route, user, [], body) },
    });
  }
  try {
    await migration("001_market.sql");
    await migration("20261121_medawee_items_staging.sql");
    await db.exec("INSERT INTO medawee_items_staging(english_name,completion_status) VALUES('Previous','historical')");
    await migration("20261121_medawee_items_staging_intake.sql");
    await migration("20261126_medawee_item_market_review.sql");
    const evidence = { sourceKind: "official_catalog", sourceUrl: "https://www.yepharma.com/products.aspx?pnum=31",
      medaweeAgentUrl: "https://medawee.com/medicines/entity/agent/abcdef0123456789abcdef01/agent",
      observedAt: "2026-11-21T11:00:00+03:00", note: "Explicit old currency on source." };
    const item = { englishName: "A product", defaultSalePriceOldCurrency: "12345678901234.0123", evidence };
    const payload = { batchId: randomUUID(), rows: [item, { englishName: "No price", evidence }] };
    assert.equal((await req("GET", null)).status, 403);
    assert.equal((await req("POST", { ...owner, owner: false }, payload)).status, 403);
    assert.equal((await req("POST", { ...owner, suspended: true }, payload)).status, 403);
    assert.equal((await req("POST", owner, { ...payload, rows: [{ ...item, completionStatus: "complete" }] })).status, 400);
    assert.equal((await req("POST", owner, { ...payload, rows: [{ ...item, defaultSalePriceOldCurrency: 0.1 }] })).status, 400);
    assert.equal((await req("POST", owner, { ...payload, rows: [{ ...item, evidence: { ...evidence, sourceKind: "medawee", sourceUrl: "https://medawee.com.evil.test/medicines/item" } }] })).status, 400);
    assert.equal((await req("POST", owner, { ...payload, rows: Array.from({length:21}, () => item) })).status, 400);
    for (const sourceUrl of ["http://www.yepharma.com/products.aspx?pnum=31", "https://localhost/x",
      "https://127.0.0.1/x", "https://a.test/x", "https://name@www.yepharma.com/x"]) {
      assert.equal((await req("POST", owner, { ...payload, rows: [{ ...item, evidence: { ...evidence, sourceUrl } }] })).status, 400);
    }
    assert.equal((await req("POST", owner, { ...payload, rows: [{ ...item, evidence: { ...evidence, medaweeAgentUrl: "https://medawee.com/medicines" } }] })).status, 400);
    const document = { sourceKind: "authorized_document", medaweeAgentUrl: evidence.medaweeAgentUrl,
      observedAt: evidence.observedAt, note: "Authorized saved statement", documentId: "alraesy:919", locator: "صفحة 3، سطر 4" };
    assert.equal((await req("POST", owner, { ...payload, rows: [{ ...item, evidence: { ...document, locator: "" } }] })).status, 400);
    assert.equal((await req("POST", owner, { ...payload, rows: [{ ...item, evidence: { ...document, sourceUrl: evidence.sourceUrl } }] })).status, 400);
    const response = await req("POST", owner, payload);
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.equal(receipt.inserted, 2);
    assert.equal(receipt.replayed, false);
    assert.equal(receipt.items[0].defaultSalePriceOldCurrency, item.defaultSalePriceOldCurrency);
    assert.equal(receipt.items[1].defaultSalePriceOldCurrency, null);
    assert.equal(receipt.items[0].completionStatus, "غير منجز");
    assert.deepEqual(receipt.items[0].evidence, evidence);
    const replay = await req("POST", owner, payload);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ...receipt, replayed: true });
    const conflict = await req("POST", owner, { ...payload, rows: [{ ...item, englishName: "Changed" }] });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "medawee_batch_conflict");
    assert.equal((await req("POST", { ...owner, id: 2 }, payload)).status, 409);
    const duplicateSource = await req("POST", owner, { batchId: randomUUID(), rows: [item] });
    assert.equal(duplicateSource.status, 201);
    assert.notEqual((await duplicateSource.json()).items[0].id, receipt.items[0].id);
    const first = await (await req("GET", owner, undefined, "?pageSize=1")).json();
    assert.equal(first.items[0].englishName, "Previous");
    assert.equal(first.items[0].completionStatus, "historical");
    assert.equal(first.items[0].evidence, null);
    const later = await (await req("GET", owner, undefined, "?after="+first.nextCursor+"&pageSize=3")).json();
    assert.deepEqual(later.items.slice(0,2), receipt.items);
    assert.equal(later.nextCursor, null);
    const goodDocument = await req("POST", owner, { batchId: randomUUID(), rows: [{ ...item, evidence: document }] });
    assert.equal(goodDocument.status, 201);
    assert.deepEqual((await goodDocument.json()).items[0].evidence, document);
    const medawee = { ...evidence, sourceKind: "medawee", sourceUrl: "https://medawee.com/medicines/drug/abcdef0123456789abcdef01" };
    assert.equal((await req("POST", owner, { batchId: randomUUID(), rows: [{ ...item, evidence: medawee }] })).status, 201);
    await db.exec(`INSERT INTO users(id,display_name) VALUES(1,'Owner');
      INSERT INTO medicine_market_cards(kind,name,normalized_name,status,created_by,idempotency_key)
      VALUES ('medicine','A product','a product','published',1,'33a61126-0000-4000-8000-000000000001'),
             ('manufacturer','Maker','maker','published',1,'33a61126-0000-4000-8000-000000000002');`);
    const complete = { id: receipt.items[0].id, expectedRevision: 0, status: "complete", marketCardId: 1 };
    const partial = { id: receipt.items[1].id, expectedRevision: 0, status: "needs_verification",
      marketCardId: null, remaining: "العبوة" };
    assert.equal((await req("PATCH", { ...owner, owner: false }, { entries: [complete] })).status, 403);
    assert.equal((await req("PATCH", owner, { entries: [complete, complete] })).status, 400);
    assert.equal((await req("PATCH", owner, { entries: [{ ...partial, remaining: " " }] })).status, 400);
    assert.equal((await req("PATCH", owner, { entries: [complete, { ...partial, marketCardId: 2 }] })).status, 422);
    const afterRollback = await (await req("GET", owner, undefined, "?after=1&pageSize=2")).json();
    assert.deepEqual(afterRollback.items, receipt.items);
    assert.equal((await db.query("SELECT * FROM audit_events")).rows.length, 0);
    const review = await req("PATCH", owner, { entries: [partial, complete] });
    assert.equal(review.status, 200);
    const checked = (await review.json()).items;
    assert.equal(checked[0].completionStatus, "منجز بالكامل");
    assert.equal(checked[0].linkedMarketCardId, 1);
    assert.equal(checked[0].reviewRevision, 1);
    assert.equal(checked[0].defaultSalePriceOldCurrency, item.defaultSalePriceOldCurrency);
    assert.deepEqual(checked[0].evidence, evidence);
    assert.equal(checked[1].completionStatus, "تبقى التأكد من: العبوة");
    assert.equal((await req("PATCH", owner, { entries: [complete] })).status, 409);
    assert.equal((await req("PATCH", owner, { entries: [
      { ...partial, id: complete.id, expectedRevision: 1 },
    ] })).status, 409);
    const again = await (await req("PATCH", owner, { entries: [{ ...complete, expectedRevision: 1 }] })).json();
    assert.equal(again.items[0].reviewRevision, 1);
    assert.equal((await db.query("SELECT * FROM audit_events")).rows.length, 2);
    await db.exec("ALTER TABLE medawee_items_staging ADD CHECK (english_name IS DISTINCT FROM 'Force rollback')");
    const failed = { batchId: randomUUID(), rows: [{ ...item, englishName: "Must roll back" }, { ...item, englishName: "Force rollback" }] };
    assert.equal((await req("POST", owner, failed)).status, 503);
    assert.equal((await db.query("SELECT 1 FROM medawee_items_staging WHERE english_name='Must roll back'")).rows.length, 0);
    assert.equal((await db.query("SELECT 1 FROM medawee_item_intake_batches WHERE batch_id=$1", [failed.batchId])).rows.length, 0);
    assert.equal((await req("POST", owner, { ...failed, rows: [item] })).status, 201);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
  }
});

test("Medawee list walks all mixed-width bigint IDs in numeric order with string cursors", async () => {
  const db = await PGlite.create();
  try {
    for (const migration of ["001_market.sql", "20261121_medawee_items_staging.sql", "20261121_medawee_items_staging_intake.sql", "20261126_medawee_item_market_review.sql"]) {
      await db.exec(await readFile(new URL("../apps/api/market-migrations/" + migration, import.meta.url), "utf8"));
    }
    await db.exec(`INSERT INTO medawee_items_staging (id, english_name) OVERRIDING SYSTEM VALUE
      VALUES (100,'Hundred'), (2,'Two'), (9,'Nine'), (1,'One'), (10,'Ten'), (99,'Ninety-nine'),
        (9007199254740993,'Large A'), (9007199254740994,'Large B')`);
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    const visited: string[] = [];
    let after = "0";
    for (const [ids, next] of [
      [["1", "2", "9"], "9"],
      [["10", "99", "100"], "100"],
      [["9007199254740993", "9007199254740994"], null],
    ] as const) {
      const page = await listMedaweeItems(pool, { after, pageSize: 3 });
      assert.deepEqual(page.items.map(row => row.id), ids);
      assert.equal(page.nextCursor, next);
      visited.push(...page.items.map(row => row.id));
      if (next !== null) after = next;
    }
    assert.equal(new Set(visited).size, 8);
    assert.deepEqual(await listMedaweeItems(pool, { after: visited.at(-1)!, pageSize: 3 }),
      { items: [], nextCursor: null });
  } finally {
    await db.close();
  }
});
