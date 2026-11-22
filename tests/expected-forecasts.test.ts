import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { expectedCardCreateSchema, expectedMovementPatchSchema, expectedEndDateLimit } from "../packages/contracts/src/expected.ts";
import { transaction } from "../apps/api/src/db.ts";
import { createExpectedCard, readExpectedCard, readExpectedMovement, listExpectedCards, listExpectedMovements, expectedSections, expectedAccounts,
  updateExpectedMovement, completeExpectedMovement, processExpectedMidnight,
  expectedOccurrenceDates, expectedAdenDate, expectedNextMidnight } from "../apps/api/src/services/expected.ts";

function poolAdapter(db:PGlite):Pool {
  let tail=Promise.resolve();
  const acquire=async()=>{const previous=tail;let release!:()=>void;tail=new Promise<void>(resolve=>{release=resolve;});await previous;return release;};
  const query=async(sql:string,values?:unknown[])=>{const result=await db.query(sql,values);return {rows:result.rows,rowCount:result.affectedRows??result.rows.length};};
  return {async query(sql:string,values?:unknown[]){const release=await acquire();try{return await query(sql,values);}finally{release();}},
    async connect(){const release=await acquire();return {query,release};}} as unknown as Pool;
}
const owner={id:1,displayName:"Owner"} as User;
const baseInput={accountId:4,section:"الموردون",amount:"3000",description:"دفعة أسبوعية",recurrence:"weekly",weekday:0,endDate:"2026-12-08",expiryMode:"carry"};
const input=(changes:Record<string,unknown>={})=>expectedCardCreateSchema.parse({...baseInput,idempotencyKey:randomUUID(),...changes});

async function fixture(t:{after:(fn:()=>Promise<void>)=>void}) {
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE users(id integer PRIMARY KEY); INSERT INTO users VALUES(1);
    CREATE TABLE companies(id integer PRIMARY KEY); INSERT INTO companies VALUES(1),(2);
    CREATE TABLE accounts(id integer PRIMARY KEY,company_id integer NOT NULL,name text,code text,active boolean DEFAULT true,kind text DEFAULT 'posting',balance numeric(28,6) DEFAULT 0,UNIQUE(company_id,id));
    INSERT INTO accounts(id,company_id,name,code,balance) VALUES(4,1,'حساب ٤','1000000004',500),(5,1,'حساب آخر','1000000005',100),(6,2,'حساب الشركة الأخرى','1000000006',700);
    CREATE TABLE company_currencies(id integer PRIMARY KEY,company_id integer NOT NULL,code text); INSERT INTO company_currencies VALUES(1,1,'YER'),(2,2,'YER');
    CREATE TABLE finance_settings(company_id integer PRIMARY KEY,base_currency_id integer); INSERT INTO finance_settings VALUES(1,1),(2,2);
    CREATE TABLE audit_events(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id integer,actor_name text,scope text,company_id integer,action text,target_type text,target_id integer,before_value jsonb,after_value jsonb);
    CREATE TABLE page_registry(key text PRIMARY KEY);
    CREATE TABLE financial_documents(id integer PRIMARY KEY,company_id integer,amount numeric(28,6)); INSERT INTO financial_documents VALUES(1,1,123);
    CREATE TABLE account_statistics(company_id integer,account_id integer,balance numeric(28,6)); INSERT INTO account_statistics VALUES(1,4,500);`);
  await db.exec(await readFile(new URL("../apps/api/migrations/20261122_expected_forecasts.sql",import.meta.url),"utf8"));
  const pool=poolAdapter(db);
  const create=(changes:Record<string,unknown>={},companyId=1,today="2026-11-22")=>transaction(pool,client=>createExpectedCard(client,owner,companyId,input(changes),today));
  const snapshot=async()=>{
    const result=[];
    for(const table of ["accounts","financial_documents","account_statistics"]) result.push((await db.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows);
    return result;
  };
  return {db,pool,create,snapshot};
}

test("dates use Aden midnight, inclusive weekly endpoints, real month dates and one-time validation",()=>{
  assert.equal(expectedAdenDate(new Date("2026-11-21T20:59:59.999Z")),"2026-11-21");
  assert.equal(expectedAdenDate(new Date("2026-11-21T21:00:00.000Z")),"2026-11-22");
  assert.equal(new Date(expectedNextMidnight(new Date("2026-11-22T20:59:59Z"))).toISOString(),"2026-11-22T21:00:00.000Z");
  assert.deepEqual(expectedOccurrenceDates(input(),"2026-11-22"),["2026-11-22","2026-11-29","2026-12-06"]);
  assert.deepEqual(expectedOccurrenceDates(input({endDate:"2026-12-06"}),"2026-11-22"),["2026-11-22","2026-11-29","2026-12-06"]);
  assert.deepEqual(expectedOccurrenceDates(input({recurrence:"daily",weekday:undefined,endDate:"2026-11-24"}),"2026-11-22"),["2026-11-22","2026-11-23","2026-11-24"]);
  assert.deepEqual(expectedOccurrenceDates(input({recurrence:"monthly",weekday:undefined,monthDay:31,endDate:"2027-03-31"}),"2026-11-22"),["2026-12-31","2027-01-31","2027-03-31"]);
  assert.deepEqual(expectedOccurrenceDates(input({recurrence:"monthly",weekday:undefined,monthDay:29,endDate:"2028-03-29"}),"2028-02-01"),["2028-02-29","2028-03-29"]);
  assert.deepEqual(expectedOccurrenceDates(input({recurrence:"once",weekday:undefined,onceDate:"2026-11-22",endDate:"2026-11-22"}),"2026-11-22"),["2026-11-22"]);
  assert.throws(()=>expectedOccurrenceDates(input({recurrence:"once",weekday:undefined,onceDate:"2026-11-21"}),"2026-11-22"),/حدد تاريخ/);
  assert.throws(()=>expectedOccurrenceDates(input({endDate:"2026-11-21"}),"2026-11-22"),/يسبق تاريخ البداية/);
  assert.throws(()=>expectedOccurrenceDates(input({recurrence:"monthly",weekday:undefined,monthDay:31,endDate:"2026-11-30"}),"2026-11-22"),/لا يوجد موعد/);
  assert.throws(()=>input({onceDate:"2026-11-23"}));
  assert.throws(()=>input({amount:"1.1234567"}));
  assert.equal(input({amount:"-٠٠٣٠٠٠٫٢٥٠٠"}).amount,"-3000.25");
  assert.equal(input({amount:"-0.000000"}).amount,"0");
  assert.equal(expectedEndDateLimit("2026-08-31"),"2027-02-28");
  assert.equal(expectedEndDateLimit("2027-08-31"),"2028-02-29");
  assert.equal(expectedEndDateLimit("2026-11-22"),"2027-05-22");
  assert.deepEqual(expectedOccurrenceDates(input({startDate:"2026-12-01",endDate:"2026-12-13"}),"2026-11-22"),["2026-12-06","2026-12-13"]);
  assert.deepEqual(expectedOccurrenceDates(input({recurrence:"once",weekday:undefined,startDate:"2026-10-01",onceDate:"2026-10-15",endDate:"2026-10-31"}),"2026-11-22"),["2026-10-15"]);
  assert.equal(expectedOccurrenceDates(input({recurrence:"daily",weekday:undefined,startDate:"2026-08-31",endDate:"2027-02-28"}),"2026-11-22").at(-1),"2027-02-28");
  assert.throws(()=>input({startDate:"2026-08-31",endDate:"2027-03-01"}),/ستة أشهر/);
  assert.throws(()=>expectedOccurrenceDates(input({endDate:"2027-05-23"}),"2026-11-22"),/ستة أشهر/);
  assert.throws(()=>input({recurrence:"once",weekday:undefined,startDate:"2026-11-25",onceDate:"2026-11-24"}),/يسبق تاريخ البداية/);
  assert.equal(expectedCardCreateSchema.safeParse({...baseInput,idempotencyKey:randomUUID(),startDate:"2026-02-31"}).success,false);
});

test("saving materializes every occurrence and idempotency prevents duplicate cards, dates and audit events",async t=>{
  const {db,pool,snapshot}=await fixture(t);const before=await snapshot();
  const value=input();
  const save=()=>transaction(pool,client=>createExpectedCard(client,owner,1,value,"2026-11-22"));
  const results=await Promise.all([save(),save()]);
  assert.equal(results[0].card.id,results[1].card.id);
  assert.deepEqual(results.map(row=>row.created),[true,false]);
  const card=results[0].card;
  assert.equal(card.movementCount,3);assert.equal(card.pendingCount,3);assert.equal(card.completedCount,0);
  assert.equal(card.accountName,"حساب ٤");assert.equal(card.section,"الموردون");
  assert.equal(card.createdById,owner.id);assert.equal(card.createdByName,"Owner");assert.ok(card.createdAt);
  const first=(await listExpectedMovements(pool,1,{})).items[0];
  assert.equal(first.postedById,owner.id);assert.equal(first.postedByName,"Owner");assert.ok(first.postedAt);
  assert.deepEqual((await listExpectedMovements(pool,1,{})).items.map(row=>[row.date,row.amount,row.description,row.status]),[
    ["2026-11-22","3000.000000","دفعة أسبوعية","pending"],["2026-11-29","3000.000000","دفعة أسبوعية","pending"],["2026-12-06","3000.000000","دفعة أسبوعية","pending"],
  ]);
  await assert.rejects(transaction(pool,client=>createExpectedCard(client,owner,1,{...value,amount:"4"},"2026-11-22")),/مفتاح الحفظ/);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM expected_cards")).rows[0].n,1);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM audit_events")).rows[0].n,1);
  await assert.rejects(db.query("UPDATE expected_cards SET end_date='2027-05-23' WHERE id=$1",[card.id]),/check constraint/i);
  assert.deepEqual(await snapshot(),before,"planning writes must leave accounting and balances exactly intact");
});

test("editing an occurrence stays pending; completion captures its current exact amount and never rewrites originals",async t=>{
  const {pool,create,snapshot}=await fixture(t);const before=await snapshot();
  const {card}=await create();
  const rows=(await listExpectedMovements(pool,1,{})).items;
  const changed=await transaction(pool,client=>updateExpectedMovement(client,owner,1,rows[1].id,expectedMovementPatchSchema.parse({revision:1,date:"2026-11-30",amount:"2500.123456",description:"دفعة معدلة"})));
  assert.equal(changed.status,"pending");assert.equal(changed.completedAmount,null);assert.equal(changed.originalDate,"2026-11-29");
  assert.equal(changed.date,"2026-11-30");assert.equal(changed.revision,2);
  assert.equal(changed.postedAt,rows[1].postedAt);assert.equal(changed.postedByName,rows[1].postedByName);
  await assert.rejects(transaction(pool,client=>completeExpectedMovement(client,owner,1,changed.id,1)),/تغيرت الحركة/);
  const completed=await transaction(pool,client=>completeExpectedMovement(client,owner,1,changed.id,2));
  assert.equal(completed.completedAmount,"2500.123456");assert.equal(completed.status,"completed");assert.equal(completed.completionSource,"manual");
  assert.equal(completed.completedById,owner.id);assert.equal(completed.completedByName,"Owner");
  assert.equal(completed.description,"دفعة معدلة");assert.equal(completed.date,"2026-11-30");
  assert.deepEqual(await transaction(pool,client=>completeExpectedMovement(client,owner,1,changed.id,2)),completed);
  await assert.rejects(transaction(pool,client=>updateExpectedMovement(client,owner,1,changed.id,{revision:3,date:completed.date,amount:"7",description:"bad"})),/منجزة/);
  const original=await readExpectedCard(pool,1,card.id);
  assert.equal(original.amount,"3000.000000");assert.equal(original.description,"دفعة أسبوعية");assert.equal(original.pendingCount,2);
  assert.equal((await readExpectedMovement(pool,1,rows[0].id)).amount,"3000.000000");
  assert.equal((await readExpectedMovement(pool,1,rows[2].id)).description,"دفعة أسبوعية");
  assert.deepEqual(await snapshot(),before);
});

test("midnight reuses the same carry row after card expiry, respects edited dates, and is repeat-safe",async t=>{
  const {pool,create,snapshot}=await fixture(t);const before=await snapshot();
  await create({recurrence:"once",weekday:undefined,onceDate:"2026-11-22",endDate:"2026-11-22",amount:"-3000"});
  const initial=(await listExpectedMovements(pool,1,{})).items[0];
  const edited=await transaction(pool,client=>updateExpectedMovement(client,owner,1,initial.id,{revision:1,date:"2026-11-24",amount:"-2500.000001",description:"قبض مؤجل"}));
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-23T21:00:00Z")),{carried:0,completed:0});
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-24T21:00:00Z")),{carried:1,completed:0});
  const carried=await readExpectedMovement(pool,1,initial.id);
  assert.equal(carried.date,"2026-11-25");assert.equal(carried.originalDate,"2026-11-22");
  assert.equal(carried.amount,"-2500.000001");assert.equal(carried.description,"قبض مؤجل");assert.equal(carried.status,"pending");assert.equal(carried.revision,edited.revision+1);
  assert.equal(carried.postedById,null);assert.equal(carried.postedByName,"النظام");assert.notEqual(carried.postedAt,initial.postedAt);
  assert.equal((await readExpectedCard(pool,1,initial.cardId)).createdByName,"Owner");
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-25T10:00:00Z")),{carried:0,completed:0});
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-12-08T21:00:00Z")),{carried:1,completed:0});
  const caughtUp=await readExpectedMovement(pool,1,initial.id);
  assert.equal(caughtUp.date,"2026-12-09");assert.equal((await listExpectedMovements(pool,1,{})).total,1);
  await assert.rejects(transaction(pool,client=>updateExpectedMovement(client,owner,1,initial.id,{revision:edited.revision,date:"2026-11-22",amount:"1",description:"stale"})),/تغيرت الحركة/);
  const done=await transaction(pool,client=>completeExpectedMovement(client,owner,1,initial.id,caughtUp.revision));
  assert.equal(done.completedAmount,"-2500.000001");
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-12-10T21:00:00Z")),{carried:0,completed:0});
  assert.deepEqual(await snapshot(),before);
});

test("automatic completion keeps edited date and signed amount; today/future remain pending and repeated processing adds no audit",async t=>{
  const {db,pool,create,snapshot}=await fixture(t);const before=await snapshot();
  const {card}=await create({recurrence:"daily",weekday:undefined,endDate:"2026-11-24",expiryMode:"complete",amount:"-3000"});
  const rows=(await listExpectedMovements(pool,1,{cardId:String(card.id)})).items;
  await transaction(pool,client=>updateExpectedMovement(client,owner,1,rows[0].id,{revision:1,date:"2026-11-24",amount:"-2500",description:"قبض عدل موعده"}));
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-22T21:00:00Z")),{carried:0,completed:0});
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-23T21:00:00Z")),{carried:0,completed:1});
  assert.equal((await readExpectedMovement(pool,1,rows[0].id)).status,"pending");
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-24T21:00:00Z")),{carried:0,completed:2});
  const completed=await readExpectedMovement(pool,1,rows[0].id);
  assert.equal(completed.date,"2026-11-24");assert.equal(completed.completedAmount,"-2500.000000");assert.equal(completed.completionSource,"automatic");
  assert.equal(completed.completedById,null);assert.equal(completed.completedByName,"النظام");
  assert.equal(completed.postedByName,"Owner");assert.equal(completed.postedAt,rows[0].postedAt);
  assert.equal(completed.description,"قبض عدل موعده");assert.equal(completed.originalDate,"2026-11-22");
  const count=(await db.query<{n:number}>("SELECT count(*)::integer AS n FROM audit_events")).rows[0].n;
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-25T10:00:00Z")),{carried:0,completed:0});
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM audit_events")).rows[0].n,count);
  assert.equal((await readExpectedCard(pool,1,card.id)).amount,"-3000.000000");
  assert.deepEqual(await snapshot(),before);
});

test("company isolation, free sections, global sort and pagination preserve boundaries",async t=>{
  const {db,pool,create}=await fixture(t);
  const single={recurrence:"once",weekday:undefined,onceDate:"2026-11-22",endDate:"2026-11-22"};
  const one=await create({...single,section:"أجور",amount:"2"});
  await create({...single,section:"أجور",amount:"10",accountId:5});
  await create({...single,section:"بدل نقل",amount:"-4"});
  await create({...single,section:"سرية",accountId:6},2);
  assert.deepEqual((await listExpectedCards(pool,1,{sort:"amount:desc",pageSize:"1",page:"1"})).items.map(row=>row.amount),["10.000000"]);
  assert.deepEqual((await listExpectedMovements(pool,1,{sort:"amount:desc",pageSize:"1",page:"2"})).items.map(row=>row.amount),["2.000000"]);
  assert.equal((await listExpectedMovements(pool,1,{section:"أجور"})).total,2);
  assert.equal((await listExpectedCards(pool,1,{q:"بدل نقل"})).total,1);
  assert.deepEqual(new Set((await expectedSections(pool,1,undefined)).items),new Set(["أجور","بدل نقل"]));
  assert.deepEqual((await expectedSections(pool,1,"نقل")).items,["بدل نقل"]);
  await assert.rejects(readExpectedCard(pool,2,one.card.id),/غير موجود/);
  const movement=(await listExpectedMovements(pool,1,{cardId:String(one.card.id)})).items[0];
  await assert.rejects(transaction(pool,client=>updateExpectedMovement(client,owner,2,movement.id,{revision:1,date:movement.date,amount:"0",description:"cross"})),/غير موجود/);
  await assert.rejects(create({...single,accountId:6}),/اختر حسابًا/);
  await assert.rejects(db.query("INSERT INTO expected_movements(company_id,card_id,original_date,movement_date,amount,posted_by_name) VALUES(2,$1,'2026-11-23','2026-11-23',1,'Owner')",[one.card.id]),/foreign key/i);
  assert.equal((await listExpectedCards(pool,1,{})).total,3);
  assert.equal((await listExpectedCards(pool,2,{})).total,1);
  const picker=await expectedAccounts(pool,1,{q:"حساب",pageSize:"1",sort:"code:asc"});
  assert.equal(picker.total,2);assert.equal(picker.items.length,1);assert.deepEqual(Object.keys(picker.items[0]).sort(),["code","id","name"]);
  assert.equal((await expectedAccounts(pool,1,{q:"1000000006"})).total,0);
  await db.query("UPDATE accounts SET active=false WHERE id=5");
  assert.equal((await expectedAccounts(pool,1,{})).total,1);
  const earlier=await create({...single,startDate:"2026-10-01",onceDate:"2026-10-15",endDate:"2026-10-31"});
  assert.equal(earlier.card.startDate,"2026-10-01");
  assert.equal((await listExpectedMovements(pool,1,{cardId:String(earlier.card.id)})).items[0].date,"2026-10-15");
});
