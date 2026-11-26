import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import express, { type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import { medicineMarketRoutes } from "../apps/api/src/routes-medicine-market.ts";
import type { MarketKind, MarketRelatedMedicinesPage } from "../packages/contracts/src/medicine-market.ts";

test("related market medicines page by exact relation and omit hidden cards and the current medicine", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  for (const file of ["001_market.sql", "20261116_card_statistics.sql", "20261117_card_rating_statistics.sql", "20261127_agent_manufacturer_statistics.sql"]) {
    await db.exec(await readFile("apps/api/market-migrations/" + file, "utf8"));
  }
  await db.exec("INSERT INTO users(id,display_name) VALUES(1,'Owner')");
  async function add(kind: MarketKind, name: string, data = {}, status = "published", archived = false) {
    const result = await db.query<{ id: number }>(
      `INSERT INTO medicine_market_cards(kind,name,normalized_name,data,status,archived,created_by,idempotency_key)
       VALUES($1,$2,$2,$3,$4,$5,1,$6) RETURNING id`,
      [kind, name, JSON.stringify(data), status, archived, randomUUID()],
    );
    return result.rows[0]!.id;
  }
  const agent = await add("agent", "Agent");
  const manufacturer = await add("manufacturer", "Manufacturer");
  const composition = await add("composition", "Composition");
  const otherComposition = await add("composition", "Other composition");
  const hiddenAgent = await add("agent", "Hidden agent", {}, "pending");
  const links = { agentId: agent, manufacturerId: manufacturer, compositionId: composition };
  const medicine = await add("medicine", "Current", { compositionId: String(composition) });
  const unlinked = await add("medicine", "Unlinked");
  const malformed = await add("medicine", "Malformed", { compositionId: [composition] });
  const agentOnly = await add("medicine", "Agent alone", { agentId: agent });
  const manufacturerOnly = await add("medicine", "Manufacturer alone", { manufacturerId: manufacturer });
  const anotherForm = await add("medicine", "Other form", { compositionId: otherComposition });
  const related = [];
  const image = "https://example.test/item.webp";
  for (let i = 0; i < 41; i++) {
    related.unshift(await add("medicine", `Item ${i}`, {
      ...links, agentId: String(agent), englishName: `Medicine ${i}`,
      image, purchasePrice: "600",
      accountingMappings: [{ system: "test", identifier: "private" }],
    }));
  }
  await add("medicine", "Archived", links, "published", true);
  await add("medicine", "Pending", links, "pending");
  await add("medicine", "Rejected", links, "rejected");
  await add("manufacturer", "Not a medicine", links);
  const sampleId = related[0]!;
  await db.query("INSERT INTO medicine_market_reactions(card_id,user_id,liked,rating) VALUES($1,1,true,4)", [sampleId]);
  await db.query(
    "INSERT INTO medicine_market_comments(card_id,author_id,text,status,idempotency_key) VALUES($1,1,'Comment','approved',$2)",
    [sampleId, randomUUID()],
  );
  await db.query("SELECT market_record_open($1,1,$2)", [sampleId, randomUUID()]);

  const app = express();
  app.use(medicineMarketRoutes(db as unknown as Pool, {
    async viewer() { return null; },
    async enabled() {},
  }, true));
  app.use(((error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ message: error.message });
  }) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/medicine-market/cards`;
  const request = (id: number, query = "") => fetch(`${root}/${id}/related-medicines${query}`);
  async function get(id: number, cursor?: number) {
    const response = await request(id, cursor === undefined ? "" : `?cursor=${cursor}`);
    assert.equal(response.status, 200);
    return await response.json() as MarketRelatedMedicinesPage;
  }
  async function all(id: number) {
    const first = await get(id);
    assert.equal(first.items.length, 20);
    assert(first.nextCursor);
    const second = await get(id, first.nextCursor);
    assert.equal(second.items.length, 20);
    assert(second.nextCursor);
    const last = await get(id, second.nextCursor);
    assert.equal(last.nextCursor, null);
    return [...first.items, ...second.items, ...last.items].map(item => item.id);
  }

  const { englishName, ...card } = (await get(agent)).items[0]!;
  const catalog = await fetch(`${root}?kind=medicine&q=${sampleId}`);
  assert.equal(catalog.status, 200);
  assert.deepEqual(card, (await catalog.json()).items[0]);
  assert.equal(englishName, "Medicine 40");
  assert.equal(card.data.image, image);
  assert.equal(card.data.purchasePrice, "600");
  assert.equal(card.data.accountingMappings, undefined);
  assert.equal(card.likes, 1);
  assert.equal(card.statistics?.comments, 1);
  assert.equal(card.statistics?.opens, 1);
  assert.equal(card.statistics?.ratingAverage, 4);
  assert.equal(card.statistics?.relations.alternatives, 41);
  const detail = async (id: number) => {
    const response = await fetch(`${root}/${id}`);
    assert.equal(response.status, 200);
    return (await response.json()).card;
  };
  const list = async (q: string) => {
    const response = await fetch(`${root}?${q}`);
    assert.equal(response.status, 200);
    return await response.json();
  };
  assert.equal((await detail(medicine)).statistics.relations.alternatives, 41);
  assert.equal((await detail(malformed)).statistics.relations.alternatives, 0);
  assert.equal((await detail(anotherForm)).statistics.relations.alternatives, 0);
  assert.deepEqual((await list("kind=medicine&sort=alternatives&pageSize=1&page=2")).items.map(x=>x.id), [related[1]]);
  assert.equal((await list("kind=medicine&sort=alternatives&q="+medicine)).items[0].statistics.relations.alternatives,41);
  for (const sort of ["opens", "comments", "likes", "ratingAverage", "ratingCount"])
    assert.equal((await list("kind=medicine&pageSize=1&sort="+sort)).items[0].id,sampleId);
  assert.equal((await list("kind=composition&sort=medicines&pageSize=1")).items[0].id,composition);
  const newAgent = await add("agent", "Second agent");
  await add("manufacturer", "Direct manufacturer", {agentId: agent});
  await add("manufacturer", "Other direct manufacturer", {agentId: agent}, "published", true);
  assert.equal((await list("kind=agent&sort=manufacturers&pageSize=1")).items[0].id,agent);
  assert.equal((await detail(newAgent)).statistics.relations.manufacturers,0);
  assert.deepEqual(await all(agent), [...related, agentOnly]);
  assert.deepEqual(await all(manufacturer), [...related, manufacturerOnly]);
  assert.deepEqual(await all(composition), [...related, medicine]);
  assert.deepEqual(await all(medicine), related);
  assert.deepEqual((await get(otherComposition)).items.map(item => item.id), [anotherForm]);
  for (const id of [unlinked, malformed, anotherForm]) {
    assert.deepEqual(await get(id), { items: [], nextCursor: null });
  }
  // A subsequent archive immediately changes the other medicines' statistic.
  await db.query("UPDATE medicine_market_cards SET archived=true WHERE id=$1",[sampleId]);
  assert.equal((await detail(medicine)).statistics.relations.alternatives,40);
  await db.query("UPDATE medicine_market_cards SET archived=true WHERE id=$1",[composition]);
  assert.equal((await detail(medicine)).statistics.relations.alternatives,40);
  assert.equal((await list("kind=medicine&sort=alternatives&q="+medicine)).items[0].statistics.relations.alternatives,40);
  assert.equal((await request(hiddenAgent)).status, 404);
  assert.equal((await request(agent, "?cursor=0")).status, 400);
});
