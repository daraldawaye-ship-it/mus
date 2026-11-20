import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import express, { type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { medicineMarketRoutes } from "../apps/api/src/routes-medicine-market.ts";
import { HttpError } from "../apps/api/src/errors.ts";
import { searchSavedMarketCards } from "../apps/web/src/market-offline.ts";
import { ZodError } from "zod";

test("public bilingual classifications support ordered lookup, composition links and ordinary interactions", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  for (const path of ["001_market.sql", "002_reference_geography.sql", "20261120_drug_classification.sql"])
    await db.exec(await readFile("apps/api/market-migrations/" + path, "utf8"));
  await db.exec("INSERT INTO users(id,display_name) VALUES (1,'Owner'),(2,'Member')");
  const query = db.query.bind(db);
  const pool = { query, connect: async () => ({query, release() {}}) } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use(medicineMarketRoutes(pool, {
    async viewer(_db, req, write) {
      const id = Number(req.get("x-test-user") ?? 0);
      if (!id && write) throw new HttpError(401, "unauthenticated", "Sign in");
      return id ? { id, displayName: id===1 ? "Owner":"Member", owner:id===1, kind:id===1 ? "admin":"member" } as User : null;
    },
    async enabled() {},
  }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 500)
      .json({message:error.message});
  };
  app.use(errors);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => {server.close();});
  await once(server,"listening");
  const address=server.address();
  assert.ok(address && typeof address === "object");
  const call=async (method:string,path:string,body?:unknown,user=1,status=200)=>{
    const res=await fetch("http://127.0.0.1:"+address.port+"/medicine-market"+path,{
      method,headers:{"content-type":"application/json","x-test-user":String(user)},
      body:body===undefined?undefined:JSON.stringify(body),
    });
    const val=await res.json();
    assert.equal(res.status,status,JSON.stringify(val));
    return val;
  };
  const create=async (kind:string,name:string)=>
    (await call("POST","/cards",{kind,name,idempotencyKey:randomUUID()},1,201)).card;
  const set=async (id:number,fieldKey:string,value:unknown,expectedValue:unknown=null,status=201)=>
    call("POST","/cards/"+id+"/contributions",{fieldKey,value,expectedValue,idempotencyKey:randomUUID()},1,status);
  const a=await create("drug-classification","مضادات البكتيريا - المضادات الحيوية");
  const b=await create("drug-classification","مضادات الفيروسات");
  await set(a.id,"englishName","Antibacterials / Antibiotics");
  await set(b.id,"englishName","Antivirals");
  const meta=await call("GET","/meta",undefined,0);
  assert.equal(meta.types.find((x:{key:string})=>x.key==="drug-classification").label,"التصانيف الدوائية");
  const list=await call("GET","/cards?kind=drug-classification",undefined,0);
  assert.deepEqual(list.items.map((x:{id:number})=>x.id),[a.id,b.id]);
  assert.deepEqual(searchSavedMarketCards(list.items, "/medicine-market/cards?kind=drug-classification").items.map(x=>x.id),[a.id,b.id]);
  assert.equal((await call("GET","/cards?kind=drug-classification&q=antibiotics",undefined,0)).items[0].id,a.id);
  const c=await create("composition","Test Composition 10 mg");
  assert.equal(c.data.drugClassificationId,undefined);
  await set(c.id,"drugClassificationId",c.id,null,400);
  assert.equal((await set(c.id,"drugClassificationId",a.id)).card.data.drugClassificationId,a.id);
  const wrong=await create("medicine","Test Medicine");
  await set(wrong.id,"drugClassificationId",a.id,null,404);
  await call("PUT","/cards/"+a.id+"/reaction",{liked:true,rating:5},2);
  await call("POST","/cards/"+a.id+"/comments",{text:"Visible test comment",idempotencyKey:randomUUID()},1,201);
  const pub=await call("GET","/cards/"+a.id,undefined,0);
  assert.equal(pub.card.likes,1);
  assert.equal(pub.card.ratingAverage,5);
  assert.equal(pub.comments[0].text,"Visible test comment");
});
