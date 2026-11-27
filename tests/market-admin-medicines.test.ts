import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import express, { type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import { ZodError } from "zod";
import type { User } from "../packages/contracts/src/index.ts";
import { HttpError } from "../apps/api/src/errors.ts";
import { medicineMarketRoutes } from "../apps/api/src/routes-medicine-market.ts";

for (const isolated of [false,true]) test(`market admin list guards access and sorts linked totals before pagination (isolated=${isolated})`, async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await readFile("apps/api/market-migrations/001_market.sql", "utf8"));
  if (isolated) for (const file of ["20261116_card_statistics.sql","20261117_card_rating_statistics.sql","20261127_agent_manufacturer_statistics.sql"])
    await db.exec(await readFile("apps/api/market-migrations/" + file, "utf8"));
  await db.exec("INSERT INTO users(id,display_name) VALUES(1,'Owner')");
  const add = async (kind: string, name: string, data = {}, archived = false, status = "published") =>
    (await db.query<{id:number}>(`INSERT INTO medicine_market_cards
      (kind,name,normalized_name,data,status,archived,created_by,idempotency_key)
      VALUES($1,$2,lower($2),$3,$4,$5,1,$6) RETURNING id`,
      [kind, name, JSON.stringify(data), status, archived, randomUUID()])).rows[0]!.id;
  const logo = "/api/medicine-market/images/89ccbbd9-7311-4a6e-a3be-2c4d803b7e59";
  const agentId = await add("agent", "شركة الرازي فارما للأدوية والمستلزمات الطبية", {image:logo});
  const manufacturerAgentId = await add("agent","وكيل المصنع الاختباري");
  await add("manufacturer","مصنّع مرتبط بالرازي",{agentId});
  await add("manufacturer","مصنّع مؤرشف للرازي",{agentId},true);
  const manufacturerId = await add("manufacturer", "شركة الاختبار", {agentId:manufacturerAgentId});
  const compositionId = await add("composition", "Paracetamol 500 mg");
  const dosageFormId = await add("dosage-form", "أقراص");
  const b = await add("medicine", "بندول أقراص", {agentId,manufacturerId,compositionId,dosageFormId,englishName:"Panadol",imageUrl:"/test-image"});
  const a = await add("medicine", "اكسامول أقراص", {agentId:"not-a-reference",manufacturerId,compositionId});
  const archived = await add("medicine", "صنف مؤرشف", {agentId,compositionId}, true);
  await add("medicine", "صنف معلق", {}, false, "pending");

  const app = express();
  if (isolated) await db.exec("UPDATE market_card_statistics SET relations=market_relation_counts(card_id)");
  app.use(medicineMarketRoutes({query:db.query.bind(db)} as unknown as Pool, {
    async viewer(_db, req) {
      const mode = req.get("x-test-mode");
      if (!mode) return null;
      return {id:1,displayName:"Test",kind:"admin",owner:mode!=="other",suspended:mode==="suspended"} as User;
    },
    async enabled() {},
  },isolated));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 500).json({message:error.message});
  };
  app.use(errors);
  const server = app.listen(0,"127.0.0.1");
  t.after(() => { server.close(); });
  await once(server,"listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = (q = "", mode = "owner") => fetch(
    `http://127.0.0.1:${address.port}/medicine-market/owner/medicines?${q}`,
    {headers: {"x-test-mode":mode}},
  );
  for (const mode of ["", "other", "suspended"]) assert.equal((await get("",mode)).status,403);
  const first = await get("sort=id&direction=desc&pageSize=1");
  assert.equal(first.status,200);
  assert.match(first.headers.get("cache-control") ?? "", /no-store/);
  const page = await first.json();
  assert.equal(page.total,2);
  assert.deepEqual(page.items.map((x:{id:number}) => x.id),[a]);
  const second = await (await get("sort=id&direction=desc&pageSize=1&page=2")).json();
  assert.equal(second.items[0].id,b);
  assert.equal(second.items[0].manufacturer,"شركة الاختبار");
  assert.equal(second.items[0].composition,"Paracetamol 500 mg");
  assert.equal(second.items[0].dosageForm,"أقراص");
  assert.equal(second.items[0].hasImage,true);
  assert.equal(second.items[0].medicineImage,"/test-image");
  assert.equal(second.items[0].agentImage,logo);
  assert.equal(second.items[0].agentMedicines,1);
  assert.equal(second.items[0].agentManufacturers,1);
  assert.equal(second.items[0].compositionMedicines,2);
  assert.equal(second.items[0].manufacturerAgent,"وكيل المصنع الاختباري");
  assert.equal(page.items[0].agentMedicines,null);
  assert.equal(page.items[0].manufacturerAgent,"وكيل المصنع الاختباري");
  for (const sort of ["agentMedicines","agentManufacturers"]) {
    const top = await (await get("pageSize=1&sort="+sort)).json();
    assert.equal(top.items[0].id,b);
  }
  if (isolated) {
    await db.exec("UPDATE market_card_statistics SET relations=NULL");
    const fallback = await (await get("pageSize=1&sort=agentManufacturers")).json();
    assert.equal(fallback.items[0].agentManufacturers,1);
    assert.equal(fallback.items[0].compositionMedicines,2);
  }
  for (const q of ["الرازي الطبية", "Panadol الرازي", String(b)]) {
    const data = await (await get(new URLSearchParams({q,image:"present"}).toString())).json();
    assert.equal(data.total,1);
    assert.equal(data.items[0].id,b);
  }
  assert.equal((await (await get("image=missing")).json()).items[0].id,a);
  assert.equal((await (await get("archived=true")).json()).items[0].id,archived);
  assert.equal((await get("sort=unexpected")).status,400);
});
