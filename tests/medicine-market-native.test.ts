import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createMarketDatabase } from "../apps/api/src/market/database.ts";

// CI uses an ephemeral Postgres service; never points at the application's production URL.
const url = process.env.MARKET_TEST_DATABASE_URL;
test("native market database has an independent migration set and bounded connections/queries", { skip: !url }, async () => {
  const schema = "market_native_" + randomUUID().replaceAll("-", "");
  const db = await createMarketDatabase(url!, schema);
  try {
    assert.equal(db.options.max, 4);
    const result = await db.query("SELECT to_regclass('medicine_market_cards') market, to_regclass('invoices') invoices, to_regclass('sessions') sessions");
    assert.equal(result.rows[0].market, "medicine_market_cards");
    assert.equal(result.rows[0].invoices, null);
    assert.equal(result.rows[0].sessions, null);
    assert.equal((await db.query("SHOW statement_timeout")).rows[0].statement_timeout, "2500ms");
    assert.equal((await db.query("SHOW lock_timeout")).rows[0].lock_timeout, "750ms");
    const again = await createMarketDatabase(url!, schema);
    await again.end();
    assert.equal((await db.query("SELECT count(*)::int n FROM market_schema_migrations")).rows[0].n, 1);
  } finally {
    await db.end();
    const cleanup = new Pool({ connectionString: url });
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
  }
});
