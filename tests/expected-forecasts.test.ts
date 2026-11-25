import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { expectedCardCreateSchema, expectedMovementPatchSchema, expectedEndDateLimit } from "../packages/contracts/src/expected.ts";
import { transaction } from "../apps/api/src/db.ts";
import { createExpectedCard, readExpectedCard, readExpectedMovement, listExpectedCards, listExpectedMovements, expectedSections, expectedAccounts, expectedCashboxes,
  changeExpectedCardLifecycle, updateExpectedMovement, completeExpectedMovement, processExpectedMidnight,
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

async function fixture(t:{after:(fn:()=>Promise<void>)=>void},cashboxUpgrade=true) {
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE users(id integer PRIMARY KEY); INSERT INTO users VALUES(1);
    CREATE TABLE companies(id integer PRIMARY KEY); INSERT INTO companies VALUES(1),(2);
    CREATE TABLE accounts(id integer PRIMARY KEY,company_id integer NOT NULL,name text,code text,active boolean DEFAULT true,kind text DEFAULT 'posting',category text DEFAULT 'asset',cash_or_bank boolean DEFAULT false,account_choice text DEFAULT '',balance numeric(28,6) DEFAULT 0,UNIQUE(company_id,id));
    INSERT INTO accounts(id,company_id,name,code,balance) VALUES(4,1,'حساب ٤','1000000004',500),(5,1,'حساب آخر','1000000005',100),(6,2,'حساب الشركة الأخرى','1000000006',700);
    CREATE TABLE company_currencies(id integer PRIMARY KEY,company_id integer NOT NULL,code text); INSERT INTO company_currencies VALUES(1,1,'YER'),(2,2,'YER');
    CREATE TABLE finance_settings(company_id integer PRIMARY KEY,base_currency_id integer); INSERT INTO finance_settings VALUES(1,1),(2,2);
    CREATE TABLE audit_events(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id integer,actor_name text,scope text,company_id integer,action text,target_type text,target_id integer,before_value jsonb,after_value jsonb);
    CREATE TABLE page_registry(key text PRIMARY KEY);
    CREATE TABLE financial_documents(id integer PRIMARY KEY,company_id integer,amount numeric(28,6)); INSERT INTO financial_documents VALUES(1,1,123);
    CREATE TABLE account_statistics(company_id integer,account_id integer,balance numeric(28,6)); INSERT INTO account_statistics VALUES(1,4,500);`);
  await db.exec(await readFile(new URL("../apps/api/migrations/20261122_expected_forecasts.sql",import.meta.url),"utf8"));
  if(cashboxUpgrade) await db.exec(await readFile(new URL("../apps/api/migrations/20261122_expected_forecasts_cashbox.sql",import.meta.url),"utf8"));
  await db.exec(await readFile(new URL("../apps/api/migrations/20261125_expected_card_retention.sql",import.meta.url),"utf8"));
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
  assert.equal(card.cashAccountId,null);assert.equal(card.cashAccountName,null);assert.equal(card.cashAccountCode,null);
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

test("optional card cashbox uses technical eligibility, company isolation and exact identity without accounting effects",async t=>{
  const {db,pool,create,snapshot}=await fixture(t);
  await db.exec(`INSERT INTO accounts(id,company_id,name,code,active,kind,category,cash_or_bank,account_choice,balance) VALUES
    (7,1,'صندوق رئيسي','1000000007',true,'posting','asset',true,'',321),
    (8,1,'بنك محفوظ','1000000008',true,'posting','asset',true,'',1000),
    (9,1,'صندوق متوقف','1000000009',false,'posting','asset',true,'cashbox',123),
    (10,1,'مجموعة صناديق','1000000010',true,'group','asset',true,'cashbox',123),
    (11,1,'حساب التزام','1000000011',true,'posting','liability',true,'cashbox',123),
    (12,1,'صندوق بالاسم فقط','1000000012',true,'posting','asset',false,'cashbox',123),
    (13,2,'صندوق شركة أخرى','1000000013',true,'posting','asset',true,'cashbox',999);`);
  const before=await snapshot();
  const lookup=await expectedCashboxes(pool,1,{sort:"code:asc",pageSize:"1"});
  assert.equal(lookup.total,2);assert.deepEqual(lookup.items,[{id:7,name:"صندوق رئيسي",code:"1000000007"}]);
  assert.deepEqual((await expectedCashboxes(pool,1,{sort:"code:asc",pageSize:"1",page:"2"})).items,[{id:8,name:"بنك محفوظ",code:"1000000008"}]);
  assert.equal((await expectedCashboxes(pool,1,{q:"1000000013"})).total,0);
  assert.equal((await expectedCashboxes(pool,1,{q:"بالاسم"})).total,0,"account_choice and names never turn an account into a cashbox");
  assert.deepEqual((await expectedCashboxes(pool,2,{})).items.map(row=>row.id),[13]);
  const original=await create({cashAccountId:7,amount:"-1250.123456"});
  assert.equal(original.card.accountId,4);assert.equal(original.card.cashAccountId,7);
  assert.equal(original.card.cashAccountName,"صندوق رئيسي");assert.equal(original.card.cashAccountCode,"1000000007");
  assert.equal(original.card.currencyCode,"YER");assert.equal(original.card.amount,"-1250.123456");
  const blank=await create({cashAccountId:null});
  await create({cashAccountId:8});
  assert.equal(blank.card.cashAccountId,null);
  assert.equal((await listExpectedCards(pool,1,{q:"1000000007"})).items[0].id,original.card.id);
  assert.equal((await listExpectedCards(pool,1,{q:"صندوق رئيسي"})).total,1);
  assert.deepEqual((await listExpectedCards(pool,1,{sort:"cashAccountCode:desc",pageSize:"2"})).items.map(card=>card.cashAccountId),[8,7]);
  const rows=(await listExpectedMovements(pool,1,{cardId:String(original.card.id)})).items;
  assert.equal(rows.length,3);assert.equal(rows[0].accountId,4);assert.equal(Object.hasOwn(rows[0],"cashAccountId"),false);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM expected_cards")).rows[0].n,3);
  for(const cashAccountId of [4,9,10,11,12,13]) await assert.rejects(create({cashAccountId}),/اختر صندوقًا/);
  await assert.rejects(db.query("UPDATE expected_cards SET cash_account_id=13 WHERE id=$1",[original.card.id]),/foreign key/i);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM expected_cards")).rows[0].n,3);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM audit_events")).rows[0].n,3);
  await transaction(pool,client=>completeExpectedMovement(client,owner,1,rows[0].id,rows[0].revision));
  assert.equal((await readExpectedCard(pool,1,original.card.id)).cashAccountId,7);
  assert.deepEqual(await snapshot(),before,"cashbox metadata never changes its balance, target account or ledger");
});

test("cashbox upgrade preserves old cards and missing-field idempotency without altering historical payloads",async t=>{
  const {db,pool,snapshot}=await fixture(t,false);
  const {cashAccountId:_cashAccountId,...legacyInput}=input();
  const legacy=(await db.query<{id:number}>(`INSERT INTO expected_cards(company_id,account_id,section,currency_code,amount,description,recurrence,weekday,start_date,end_date,expiry_mode,created_by,created_by_name,idempotency_key,creation_payload)
    VALUES(1,4,$1,'YER',$2,$3,'weekly',0,'2026-11-22',$4,'carry',1,'Owner',$5,$6::jsonb) RETURNING id`,
    [legacyInput.section,legacyInput.amount,legacyInput.description,legacyInput.endDate,legacyInput.idempotencyKey,JSON.stringify(legacyInput)])).rows[0];
  await db.query(`INSERT INTO expected_movements(company_id,card_id,original_date,movement_date,amount,description,posted_by,posted_by_name)
    SELECT 1,$1,day,day,3000,'دفعة أسبوعية',1,'Owner' FROM unnest(ARRAY['2026-11-22','2026-11-29','2026-12-06']::date[]) day`,[legacy.id]);
  const before=(await db.query("SELECT to_jsonb(c) AS card FROM expected_cards c WHERE id=$1",[legacy.id])).rows[0];
  const movementsBefore=(await db.query("SELECT to_jsonb(m) AS movement FROM expected_movements m ORDER BY id")).rows;
  const financialBefore=await snapshot();
  await db.exec(await readFile(new URL("../apps/api/migrations/20261122_expected_forecasts_cashbox.sql",import.meta.url),"utf8"));
  const card=await readExpectedCard(pool,1,legacy.id);
  assert.equal(card.cashAccountId,null);assert.equal(card.cashAccountName,null);assert.equal(card.movementCount,3);
  assert.deepEqual((await db.query("SELECT to_jsonb(c)-'cash_account_id' AS card FROM expected_cards c WHERE id=$1",[legacy.id])).rows[0],before);
  const replay=await transaction(pool,client=>createExpectedCard(client,owner,1,expectedCardCreateSchema.parse(legacyInput),"2026-11-23"));
  assert.equal(replay.created,false);assert.equal(replay.card.id,legacy.id);
  const explicitNull=await transaction(pool,client=>createExpectedCard(client,owner,1,expectedCardCreateSchema.parse({...legacyInput,cashAccountId:null}),"2026-11-23"));
  assert.equal(explicitNull.created,false);
  await assert.rejects(transaction(pool,client=>createExpectedCard(client,owner,1,expectedCardCreateSchema.parse({...legacyInput,cashAccountId:4}),"2026-11-23")),/مفتاح الحفظ/);
  assert.deepEqual((await db.query("SELECT to_jsonb(m) AS movement FROM expected_movements m ORDER BY id")).rows,movementsBefore);
  assert.deepEqual((await db.query("SELECT to_jsonb(c)-'cash_account_id' AS card FROM expected_cards c WHERE id=$1",[legacy.id])).rows[0],before);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM audit_events")).rows[0].n,0);
  assert.deepEqual(await snapshot(),financialBefore);
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
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-23T21:00:00Z")),{carried:0,completed:0,purged:0});
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-24T21:00:00Z")),{carried:1,completed:0,purged:0});
  const carried=await readExpectedMovement(pool,1,initial.id);
  assert.equal(carried.date,"2026-11-25");assert.equal(carried.originalDate,"2026-11-22");
  assert.equal(carried.amount,"-2500.000001");assert.equal(carried.description,"قبض مؤجل");assert.equal(carried.status,"pending");assert.equal(carried.revision,edited.revision+1);
  assert.equal(carried.postedById,null);assert.equal(carried.postedByName,"النظام");assert.notEqual(carried.postedAt,initial.postedAt);
  assert.equal((await readExpectedCard(pool,1,initial.cardId)).createdByName,"Owner");
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-25T10:00:00Z")),{carried:0,completed:0,purged:0});
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-12-08T21:00:00Z")),{carried:1,completed:0,purged:0});
  const caughtUp=await readExpectedMovement(pool,1,initial.id);
  assert.equal(caughtUp.date,"2026-12-09");assert.equal((await listExpectedMovements(pool,1,{})).total,1);
  await assert.rejects(transaction(pool,client=>updateExpectedMovement(client,owner,1,initial.id,{revision:edited.revision,date:"2026-11-22",amount:"1",description:"stale"})),/تغيرت الحركة/);
  const done=await transaction(pool,client=>completeExpectedMovement(client,owner,1,initial.id,caughtUp.revision));
  assert.equal(done.completedAmount,"-2500.000001");
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-12-10T21:00:00Z")),{carried:0,completed:0,purged:0});
  assert.deepEqual(await snapshot(),before);
});

test("automatic completion keeps edited date and signed amount; today/future remain pending and repeated processing adds no audit",async t=>{
  const {db,pool,create,snapshot}=await fixture(t);const before=await snapshot();
  const {card}=await create({recurrence:"daily",weekday:undefined,endDate:"2026-11-24",expiryMode:"complete",amount:"-3000"});
  const rows=(await listExpectedMovements(pool,1,{cardId:String(card.id)})).items;
  await transaction(pool,client=>updateExpectedMovement(client,owner,1,rows[0].id,{revision:1,date:"2026-11-24",amount:"-2500",description:"قبض عدل موعده"}));
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-22T21:00:00Z")),{carried:0,completed:0,purged:0});
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-23T21:00:00Z")),{carried:0,completed:1,purged:0});
  assert.equal((await readExpectedMovement(pool,1,rows[0].id)).status,"pending");
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-24T21:00:00Z")),{carried:0,completed:2,purged:0});
  const completed=await readExpectedMovement(pool,1,rows[0].id);
  assert.equal(completed.date,"2026-11-24");assert.equal(completed.completedAmount,"-2500.000000");assert.equal(completed.completionSource,"automatic");
  assert.equal(completed.completedById,null);assert.equal(completed.completedByName,"النظام");
  assert.equal(completed.postedByName,"Owner");assert.equal(completed.postedAt,rows[0].postedAt);
  assert.equal(completed.description,"قبض عدل موعده");assert.equal(completed.originalDate,"2026-11-22");
  const count=(await db.query<{n:number}>("SELECT count(*)::integer AS n FROM audit_events")).rows[0].n;
  assert.deepEqual(await processExpectedMidnight(pool,new Date("2026-11-25T10:00:00Z")),{carried:0,completed:0,purged:0});
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

test("card cancellation is reversible; 30-day cleanup preserves past and completed data",async t=>{
  const {db,pool,create,snapshot}=await fixture(t);
  const finance=await snapshot();
  const card=(await create({recurrence:"daily",weekday:undefined,endDate:"2026-11-27"})).card;
  const other=(await create({accountId:6},2)).card;
  const items=(await listExpectedMovements(pool,1,{cardId:String(card.id)})).items;
  assert.equal(items.length,6);
  const [past,carried,today,done,backdated,future]=items;
  await db.query("UPDATE expected_movements SET movement_date='2026-11-24' WHERE id=$1",[carried.id]);
  await db.query("UPDATE expected_movements SET movement_date='2026-11-22' WHERE id=$1",[backdated.id]);
  await transaction(pool,client=>completeExpectedMovement(client,owner,1,done.id,done.revision));
  const clock=new Date("2026-11-23T21:00:00.000Z"); // Start of Nov 24 in Aden.
  const before=(await db.query("SELECT id,to_jsonb(m) AS row FROM expected_movements m WHERE id=ANY($1) ORDER BY id",[[past.id,carried.id,done.id,backdated.id]])).rows;
  const change=(action:"archive"|"restore",revision:number,companyId=1)=>
    transaction(pool,client=>changeExpectedCardLifecycle(client,owner,companyId,card.id,{action,revision},clock));
  await assert.rejects(change("archive",1,2),/غير موجود/);
  const archived=await change("archive",1);
  assert.equal(archived.archivedMovementCount,1);
  assert.equal((await listExpectedCards(pool,1,{})).total,0);
  assert.equal((await listExpectedCards(pool,1,{visibility:"archived"})).items[0].id,card.id);
  assert.equal((await listExpectedCards(pool,2,{})).items[0].id,other.id);
  assert.deepEqual((await listExpectedMovements(pool,1,{})).items.map(m=>m.id).sort(),[past.id,carried.id,today.id,done.id,backdated.id].sort());
  await assert.rejects(transaction(pool,client=>completeExpectedMovement(client,owner,1,future.id,future.revision)),/غير موجود/);
  await assert.rejects(change("restore",1),/تغيرت/);
  // Simulate the old rule hiding a same-day row, then run the repair migration.
  await db.query("UPDATE expected_movements SET archived_at=$2 WHERE id=$1",[today.id,clock]);
  const repair=await readFile(new URL("../apps/api/migrations/20261125_expected_card_retention_preserve_day.sql",import.meta.url),"utf8");
  await db.exec(repair);
  await db.exec(repair); // safe to replay
  const repaired=await readExpectedMovement(pool,1,today.id);
  assert.equal(repaired.status,"pending");
  assert.equal(repaired.cardArchived,true);
  assert.equal((await readExpectedCard(pool,1,card.id)).archivedMovementCount,1);
  const edit=expectedMovementPatchSchema.parse({revision:repaired.revision,date:"2026-11-25",amount:repaired.amount,description:repaired.description});
  await assert.rejects(transaction(pool,client=>updateExpectedMovement(client,owner,1,today.id,{...edit,description:"محاولة تغيير البيان"})),/تعديل تاريخ الحركة ومبلغها فقط/);
  const rescheduled=await transaction(pool,client=>updateExpectedMovement(client,owner,1,today.id,{...edit,amount:"2500"}));
  assert.equal(rescheduled.date,"2026-11-25");
  assert.equal(rescheduled.originalDate,"2026-11-24");
  assert.equal(rescheduled.amount,"2500.000000");
  assert.equal(rescheduled.originalAmount,repaired.originalAmount);
  assert.equal(rescheduled.status,"pending");
  const completed=await transaction(pool,client=>completeExpectedMovement(client,owner,1,today.id,rescheduled.revision));
  assert.equal(completed.status,"completed");
  assert.equal(completed.date,"2026-11-25");
  assert.equal(completed.completedAmount,"2500.000000");
  const restored=await change("restore",2);
  assert.equal(restored.archivedAt,null);
  assert.equal((await listExpectedMovements(pool,1,{})).total,6);
  assert.equal((await readExpectedMovement(pool,1,future.id)).revision,future.revision+2);
  await change("archive",3);
  const threshold=clock.getTime()+30*86400000;
  assert.equal((await processExpectedMidnight(pool,new Date(threshold-1))).purged,0);
  assert.equal((await processExpectedMidnight(pool,new Date(threshold))).purged,1);
  assert.equal((await processExpectedMidnight(pool,new Date(threshold))).purged,0);
  assert.equal((await readExpectedCard(pool,1,card.id)).purgedMovementCount,1);
  assert.deepEqual((await db.query("SELECT id,to_jsonb(m) AS row FROM expected_movements m WHERE company_id=1 AND id<>$1 ORDER BY id",[today.id])).rows,before);
  assert.equal((await db.query("SELECT 1 FROM audit_events WHERE company_id=1 AND action='expected.card.purge'")).rows.length,1);
  await assert.rejects(change("restore",5),/بعد حذف/);
  assert.deepEqual(await snapshot(), finance);
});
