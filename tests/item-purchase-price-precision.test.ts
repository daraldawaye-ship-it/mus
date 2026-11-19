import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const original = readFileSync(
  new URL("../apps/api/migrations/006_items.sql", import.meta.url), "utf8",
);
const migration = readFileSync(
  new URL("../apps/api/migrations/20261119_item_purchase_price_precision.sql", import.meta.url), "utf8",
);

async function database(t: { after: (fn: () => Promise<void>) => void }) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE company_currencies (
      company_id integer NOT NULL, id integer NOT NULL, decimal_places integer NOT NULL,
      PRIMARY KEY(company_id,id)
    );
    CREATE TABLE items (
      id integer PRIMARY KEY, company_id integer NOT NULL, currency_id integer NOT NULL,
      name text NOT NULL DEFAULT '',
      sale_price1 numeric(28,6) NOT NULL DEFAULT 0,
      sale_price2 numeric(28,6) NOT NULL DEFAULT 0,
      sale_price3 numeric(28,6) NOT NULL DEFAULT 0,
      purchase_price numeric(28,6) NOT NULL DEFAULT 0,
      FOREIGN KEY(company_id,currency_id) REFERENCES company_currencies(company_id,id)
    );
    INSERT INTO company_currencies VALUES(1,1,2),(1,2,0),(1,3,6);
  `);
  const start = original.indexOf("CREATE FUNCTION check_item_price_precision()");
  assert(start >= 0, "Original item price trigger must be present");
  await db.exec(original.slice(start));
  return db;
}

test("weighted purchase price persists with four decimals and survives unrelated card edits", async t => {
  const db = await database(t);
  await db.exec("INSERT INTO items(id,company_id,currency_id,purchase_price) VALUES(1,1,1,1000)");
  // Reproduce the live failure: the existing trigger rejects the approved
  // weighted result of (10 * 1000 + 5 * 800) / 15.
  await assert.rejects(
    db.query("UPDATE items SET purchase_price=$1 WHERE id=1", ["933.3333"]),
    /Item prices exceed currency precision/,
  );
  await db.exec(migration);
  await db.query("UPDATE items SET purchase_price=$1 WHERE id=1", ["933.3333"]);
  await db.query("UPDATE items SET name=$1 WHERE id=1", ["Updated name"]);
  const saved = await db.query<{ purchase_price: string; name: string }>(
    "SELECT purchase_price::text,name FROM items WHERE id=1",
  );
  assert.equal(saved.rows[0]!.purchase_price, "933.333300");
  assert.equal(saved.rows[0]!.name, "Updated name");
});

test("purchase precision remains bounded and sales retain currency precision", async t => {
  const db = await database(t);
  await db.exec(migration);
  await db.exec("INSERT INTO items(id,company_id,currency_id) VALUES(1,1,1),(2,1,2),(3,1,3)");
  await db.query("UPDATE items SET purchase_price=$1 WHERE id=1", ["0.0001"]);
  await assert.rejects(
    db.query("UPDATE items SET purchase_price=$1 WHERE id=1", ["0.00001"]),
    /Item prices exceed currency precision/,
  );
  for (const field of ["sale_price1", "sale_price2", "sale_price3"]) {
    await assert.rejects(
      db.query(`UPDATE items SET ${field}=$1 WHERE id=1`, ["1.001"]),
      /Item prices exceed currency precision/,
    );
  }
  await db.query("UPDATE items SET purchase_price=$1 WHERE id=2", ["933.3333"]);
  await assert.rejects(
    db.query("UPDATE items SET sale_price1=$1 WHERE id=2", ["1.1"]),
    /Item prices exceed currency precision/,
  );
  await db.query(
    "UPDATE items SET purchase_price=$1,sale_price1=$1,sale_price2=$1,sale_price3=$1 WHERE id=3",
    ["1.123456"],
  );
  const saved = await db.query<{ purchase_price: string; sale_price1: string }>(
    "SELECT purchase_price::text,sale_price1::text FROM items WHERE id=3",
  );
  assert.equal(saved.rows[0]!.purchase_price, "1.123456");
  assert.equal(saved.rows[0]!.sale_price1, "1.123456");
  await assert.rejects(
    db.query("INSERT INTO items(id,company_id,currency_id) VALUES(4,2,1)"),
    /foreign key constraint/,
  );
});
