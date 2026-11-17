import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = (name: string) =>
  readFileSync("apps/api/market-migrations/" + name, "utf8");

test("market rating projection backfills, updates instantly, and weekly reconciles", async t => {
  const db = new PGlite();
  t.after(async () => db.close());
  await db.exec(migration("001_market.sql"));
  await db.exec(`
    INSERT INTO users(id,display_name) VALUES (1,'one'),(2,'two'),(3,'three');
    INSERT INTO medicine_market_cards
      (id,kind,name,normalized_name,status,created_by,idempotency_key)
    VALUES
      (11,'medicine','Medicine A','medicine a','published',1,'00000000-0000-4000-8000-000000000011'),
      (12,'agent','Agent B','agent b','published',1,'00000000-0000-4000-8000-000000000012');
    INSERT INTO medicine_market_reactions(card_id,user_id,liked,rating) VALUES
      (11,1,true,4),(11,2,false,2),(11,3,false,NULL);
  `);
  await db.exec(migration("20261116_card_statistics.sql"));
  await db.exec(migration("20261117_card_rating_statistics.sql"));

  const get = async (cardId: number) => {
    const result = await db.query<{
      likes: string | number; rating_count: string | number;
      rating_total: string | number; rating_average: string | null;
    }>("SELECT likes,rating_count,rating_total,rating_average FROM market_card_statistics WHERE card_id=$1", [cardId]);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    return {
      likes: Number(row.likes), count: Number(row.rating_count),
      total: Number(row.rating_total),
      average: row.rating_average === null ? null : Number(row.rating_average),
    };
  };

  assert.deepEqual(await get(11), {likes:1,count:2,total:6,average:3});
  assert.deepEqual(await get(12), {likes:0,count:0,total:0,average:null});

  await db.exec("UPDATE medicine_market_reactions SET rating=5 WHERE card_id=11 AND user_id=2");
  assert.deepEqual(await get(11), {likes:1,count:2,total:9,average:4.5});
  await db.exec("UPDATE medicine_market_reactions SET liked=false, rating=NULL WHERE card_id=11 AND user_id=1");
  assert.deepEqual(await get(11), {likes:0,count:1,total:5,average:5});
  await db.exec("UPDATE medicine_market_reactions SET rating=3 WHERE card_id=11 AND user_id=3");
  assert.deepEqual(await get(11), {likes:0,count:2,total:8,average:4});
  await db.exec("UPDATE medicine_market_reactions SET liked=true WHERE card_id=11 AND user_id=3");
  assert.deepEqual(await get(11), {likes:1,count:2,total:8,average:4});
  await db.exec("DELETE FROM medicine_market_reactions WHERE card_id=11 AND user_id=3");
  assert.deepEqual(await get(11), {likes:0,count:1,total:5,average:5});

  // A legacy corruption/drift is healed by the existing seven-day verifier.
  await db.exec("UPDATE market_card_statistics SET rating_count=0,rating_total=0 WHERE card_id=11");
  const checked = await db.query<{checked:number}>("SELECT market_check_statistics(64) checked");
  assert(checked.rows[0].checked >= 2);
  assert.deepEqual(await get(11), {likes:0,count:1,total:5,average:5});
});

test("market list, detail and compact metrics share the precomputed rating", () => {
  const backend = readFileSync("apps/api/src/routes-medicine-market.ts", "utf8");
  const counts = readFileSync("apps/web/src/pages/MarketCardStatistics.tsx", "utf8");
  assert.match(backend,/s\.rating_average AS rating_average/);
  assert.match(backend,/s\.rating_count AS rating_count/);
  assert.match(backend,/statistics: \{/);
  assert.match(counts,/<Star size=\{14\}\/>/);
  assert.match(counts,/stats\.ratingAverage/);
  assert.match(counts,/stats\.ratingCount/);
});
