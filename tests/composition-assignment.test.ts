import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {PGlite} from "@electric-sql/pglite";
import {assignComposition} from "../apps/api/src/services/composition-assignment.ts";
import type {Database} from "../apps/api/src/db.ts";
import type {User} from "../packages/contracts/src/index.ts";
import type {CompositionAssignmentInput} from "../packages/contracts/src/items.ts";

async function setup(t:{after:(fn:()=>Promise<void>)=>void}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`
 CREATE TABLE companies(id integer PRIMARY KEY);
 CREATE TABLE users(id integer PRIMARY KEY);
 INSERT INTO companies VALUES(1),(2);INSERT INTO users VALUES(1);
 CREATE TABLE item_compositions(
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer NOT NULL,
  arabic_name text NOT NULL,english_name text NOT NULL,product_form text NOT NULL,
  description text DEFAULT '',sale_notes text DEFAULT '',active boolean DEFAULT true,
  identical_alternative boolean DEFAULT false,non_interchangeable boolean DEFAULT false,
  original_item_id integer,created_by integer,idempotency_key uuid,creation_payload jsonb,
  UNIQUE(company_id,id),UNIQUE(company_id,idempotency_key));
 INSERT INTO item_compositions(company_id,arabic_name,english_name,product_form)
 VALUES(1,'Old','Old','عام'),(1,'Existing Cream','Existing Cream','مرهم/كريم/جل'),(2,'Other','Other','شراب');
 CREATE TABLE items(id integer PRIMARY KEY,company_id integer,name text,
  composition_id integer,product_form text,active boolean DEFAULT true,revision integer DEFAULT 1,
  updated_at timestamptz DEFAULT now(),sale_price numeric(28,6),factor2 integer);
 INSERT INTO items(id,company_id,name,composition_id,product_form,sale_price,factor2)
 VALUES(11,1,'One',1,'عام',123.4567,10),(12,1,'Two',1,'عام',567.8912,20),(21,2,'Other',3,'شراب',99.95,1);
 CREATE TABLE stock_balances(item_id integer,quantity integer);
 INSERT INTO stock_balances VALUES(11,10),(12,20);
 CREATE TABLE audit_events(actor_id integer,actor_name text,scope text,company_id integer,
 action text,target_type text,target_id integer,before_value jsonb,after_value jsonb);
 `);
 await db.exec(await readFile(new URL("../apps/api/migrations/20261110_composition_assignments.sql",import.meta.url),"utf8"));
 const user={id:1,displayName:"Owner"} as User;
 const run=(input:CompositionAssignmentInput,company=1)=>db.transaction(tx=>
   assignComposition(tx as unknown as Database,user,company,input));
 const input=(overrides:Partial<CompositionAssignmentInput>={}):CompositionAssignmentInput=>({
  name:"New tablets",productForm:"اقراص/كبسول",targetCompositionId:null,idempotencyKey:randomUUID(),
  items:[{id:11,expectedCompositionId:1,expectedProductForm:"عام"},{id:12,expectedCompositionId:1,expectedProductForm:"عام"}],
  ...overrides,
 });
 return {db,run,input};
}
test("create and move together, map grouped tablets, preserve finance/units/stock",async t=>{
 const {db,run,input}=await setup(t);const request=input();
 const before=await db.query("SELECT sale_price::text,factor2 FROM items ORDER BY id");
 const stock=await db.query("SELECT * FROM stock_balances ORDER BY item_id");
 const result=await run(request);
 assert.equal(result.created,true);assert.equal(result.updatedCount,2);
 assert.equal(result.composition.product_form,"اقراص/كبسول");
 const items=await db.query("SELECT composition_id,product_form,revision FROM items WHERE company_id=1 ORDER BY id");
 assert.deepEqual(items.rows,[{composition_id:result.composition.id,product_form:"اقراص",revision:2},{composition_id:result.composition.id,product_form:"اقراص",revision:2}]);
 assert.deepEqual((await db.query("SELECT sale_price::text,factor2 FROM items ORDER BY id")).rows,before.rows);
 assert.deepEqual((await db.query("SELECT * FROM stock_balances ORDER BY item_id")).rows,stock.rows);
 assert.equal((await db.query("SELECT * FROM audit_events WHERE action='item.field.update'")).rows.length,4);
});
test("reuse typed exact existing name, map grouped topical forms, retry never reassigns again",async t=>{
 const {db,run,input}=await setup(t);const request=input({name:"existing cream",productForm:"شراب"});
 const result=await run(request);assert.equal(result.created,false);assert.equal(result.composition.id,2);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM item_compositions")).rows[0].n,3);
 assert.deepEqual((await db.query("SELECT product_form FROM items WHERE company_id=1 ORDER BY id")).rows,[{product_form:"مرهم"},{product_form:"مرهم"}]);
 await db.exec("UPDATE items SET composition_id=1,product_form='عام' WHERE id=11");
 const repeated=await run(request);assert.equal(repeated.replayed,true);
 assert.equal((await db.query("SELECT composition_id FROM items WHERE id=11")).rows[0].composition_id,1);
 await assert.rejects(run({...request,name:"Different"}),/مفتاح الحفظ/);
});
test("stale association or shape, cross-company item and original item abort the entire operation",async t=>{
 const {db,run,input}=await setup(t);
 const before=async()=>({
  items:(await db.query("SELECT * FROM items ORDER BY id")).rows,
  compositions:(await db.query("SELECT * FROM item_compositions ORDER BY id")).rows,
  receipts:(await db.query("SELECT * FROM item_composition_assignments")).rows,
  audit:(await db.query("SELECT * FROM audit_events")).rows,
 });
 for(const request of [
  input({items:[{id:11,expectedCompositionId:2,expectedProductForm:"عام"},{id:12,expectedCompositionId:1,expectedProductForm:"عام"}]}),
  input({items:[{id:11,expectedCompositionId:1,expectedProductForm:"كبسول"}]}),
  input({items:[{id:21,expectedCompositionId:3,expectedProductForm:"شراب"}]}),
  input({name:"Other",targetCompositionId:3}),
 ]){
  const snapshot=await before();await assert.rejects(run(request));assert.deepEqual(await before(),snapshot);
 }
 await db.exec("UPDATE item_compositions SET original_item_id=11 WHERE id=1");
 const snapshot=await before();await assert.rejects(run(input()),/أورجنال/);assert.deepEqual(await before(),snapshot);
});
test("a late database failure rolls back composition creation, links, forms, audit and receipt",async t=>{
 const {db,run,input}=await setup(t);
 await db.exec("ALTER TABLE items ADD CONSTRAINT reject_test_target CHECK (id<>12 OR product_form='عام')");
 const before=(await db.query("SELECT * FROM items ORDER BY id")).rows;
 await assert.rejects(run(input()));
 assert.deepEqual((await db.query("SELECT * FROM items ORDER BY id")).rows,before);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM item_compositions")).rows[0].n,3);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n,0);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM item_composition_assignments")).rows[0].n,0);
});
