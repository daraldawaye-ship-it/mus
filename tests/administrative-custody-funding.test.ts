import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { administrativeCustodyFundingSchema as schema, custodyBookBalanceSql, postAdministrativeCustodyFunding } from "../apps/api/src/services/administrative-custody-funding.ts";

const actor = {id: 1, displayName: "البائع"} as User;
const fields = {amount:"200.25", countedCash:"90", notes:"", idempotencyKey:"0f20ad2f-4d77-4c48-a0a3-eb22dc8e2420"};
const quote = {...fields, mode:"preview" as const};
const post = {...fields, mode:"post" as const, expectedBookBalance:"100"};

test("the physical count is mandatory, nonnegative, and accepts zero", () => {
  assert.ok(schema.safeParse({...quote, countedCash:"0"}).success);
  for (const countedCash of [undefined, "", "-1", "23.555", 20])
    assert.equal(schema.safeParse({...quote, countedCash}).success, false);
  assert.equal(schema.safeParse({...post, expectedBookBalance:undefined}).success, false);
});

test("preview, guarded separate variance, atomic rollback and idempotency use the existing journal", async () => {
  const db = new PGlite();
  const migrate = async (name:string) =>
    db.exec(await readFile(new URL("../apps/api/migrations/" + name, import.meta.url),"utf8"));
  try {
    await db.exec(`
      CREATE TABLE companies(id int PRIMARY KEY);
      INSERT INTO companies VALUES(1),(2);
      CREATE TABLE users(id int PRIMARY KEY,display_name text,owner boolean);
      INSERT INTO users VALUES(1,'seller',true),(2,'another',false);
      CREATE TABLE employees(company_id int,id int,name text,user_id int,active boolean,permissions text[],
        PRIMARY KEY(company_id,id),CHECK (permissions IS NOT NULL));
      CREATE TABLE branches(company_id int,id int,name text,PRIMARY KEY(company_id,id));
      CREATE TABLE accounts(company_id int,id int,name text,code text,active boolean,kind text,
        category text,normal_side text,PRIMARY KEY(company_id,id));
      CREATE TABLE account_links(company_id int,account_id int,purpose text);
      CREATE TABLE employee_account_links(company_id int,employee_id int,account_id int,account_kind text);
      CREATE TABLE company_currencies(company_id int,id int,code text,name text,active boolean,decimal_places int,PRIMARY KEY(company_id,id));
      CREATE TABLE finance_settings(company_id int,base_currency_id int);
      CREATE TABLE exchange_rates(company_id int,id int,PRIMARY KEY(company_id,id));
      CREATE TABLE audit_events(actor_id int,actor_name text,scope text,company_id int,action text,target_type text,target_id int,before_value jsonb,after_value jsonb);
      CREATE TABLE central_access_policies(company_id int,resource_key text,view_positions text[],edit_positions text[],updated_by int,UNIQUE(company_id,resource_key));
    `);
    await migrate("005_accounting.sql");
    await migrate("20261107_sales_custody_funding.sql");
    await db.exec(`
      ALTER TABLE financial_documents ADD COLUMN supplier_receipt_number text NOT NULL DEFAULT '';
      CREATE TABLE administrative_custody_transfers(company_id int,id int,financial_document_id int,expense_kind text,doctor_id int,
        doctor_name text,doctor_main_name text,doctor_kind text,slip_count int,accounted_cutoff_invoice_id int,accounted_invoice_count int);
      CREATE TABLE direct_medical_payments(LIKE administrative_custody_transfers);
      CREATE TABLE administrative_custody_receipts(company_id int,voucher_document_id int,source_transfer_id int);
      INSERT INTO employees VALUES(1,1,'seller',1,true,'{}');
      INSERT INTO accounts VALUES (1,10,'sales','10',true,'posting','asset','debit',true),
        (1,20,'custody','20',true,'posting','asset','debit',true),(1,30,'variance','30',true,'posting','expense','debit',false),
        (2,20,'other custody','20',true,'posting','asset','debit',true);
      INSERT INTO account_links VALUES(1,20,'administrativeCustody'),(1,30,'cashVariance');
      INSERT INTO employee_account_links VALUES(1,1,10,'sales_cash');
      INSERT INTO company_currencies VALUES(1,1,'YER','Yemeni Rial',true,2),(2,1,'YER','Yemeni Rial',true,2);
      INSERT INTO finance_settings VALUES(1,1),(2,1);
    `);
    await migrate("20261126_custody_funding_count.sql");
    const client = {query:db.query.bind(db)} as unknown as PoolClient;
    const call = (fields:unknown, user=actor) => postAdministrativeCustodyFunding(client,1,user,schema.parse(fields));
    const balance = async () => Number((await db.query<{amount:string}>(custodyBookBalanceSql,[1,20])).rows[0].amount);
    const count = async () => Number((await db.query<{count:string}>("SELECT count(*) FROM financial_documents WHERE company_id=1")).rows[0].count);
    // Establish the starting balance using the actual existing two-sided posting.
    const initial = await call({...post, idempotencyKey:"218eb853-4414-4c1c-8dda-6c5d38baf8cd",
      amount:"100",countedCash:"0",expectedBookBalance:"0"});
    assert.ok("documentId" in initial);
    assert.equal(initial.varianceDocumentId,null);
    assert.equal(await balance(),100);
    assert.deepEqual(await call(quote),{bookBalance:"100",varianceKind:"shortage",varianceAmount:"10"});
    assert.equal(await count(),1);
    await assert.rejects(call({...post, expectedBookBalance:"99"}), {code:"custody_funding_count_changed"});
    assert.equal(await count(),1);
    await db.exec("DELETE FROM account_links WHERE purpose='cashVariance'");
    await assert.rejects(call(post), {code:"custody_funding_variance_account_missing"});
    assert.equal(await count(),1);
    await db.exec("INSERT INTO account_links VALUES(1,30,'cashVariance')");
    const result = await call(post);
    assert.ok("documentId" in result);
    assert.equal(result.varianceKind,"shortage");
    assert.equal(await count(),3);
    assert.equal(await balance(),290.25);
    assert.deepEqual((await db.query("SELECT account_id,debit::float8,credit::float8 FROM financial_document_lines WHERE document_id=$1 ORDER BY account_id",[result.varianceDocumentId])).rows,
      [{account_id:20,debit:0,credit:10},{account_id:30,debit:10,credit:0}]);
    assert.deepEqual(await call(post),result);
    await assert.rejects(call({...post, countedCash:"91"}), {code:"custody_funding_key_conflict"});
    await assert.rejects(call(post,{...actor,id:2}), {code:"custody_funding_key_conflict"});
    assert.equal(await count(),3);
    await db.exec("BEGIN");
    await call({...post, idempotencyKey:"8ed59703-0039-43fa-bb4a-dccebab93382",
      amount:"10", countedCash:"300", expectedBookBalance:"290.25"});
    assert.equal(await balance(),310);
    await db.exec("ROLLBACK");
    assert.equal(await balance(),290.25);
    const over = await call({...post, idempotencyKey:"8ed59703-0039-43fa-bb4a-dccebab93382",
      amount:"10", countedCash:"300", expectedBookBalance:"290.25"});
    assert.ok("varianceDocumentId" in over);
    assert.equal(over.varianceKind,"surplus");
    assert.deepEqual((await db.query("SELECT account_id,debit::float8,credit::float8 FROM financial_document_lines WHERE document_id=$1 ORDER BY account_id",[over.varianceDocumentId])).rows,
      [{account_id:20,debit:9.75,credit:0},{account_id:30,debit:0,credit:9.75}]);
    assert.equal(await balance(),310);
    assert.equal(await count(),5);
    assert.equal((await db.query<{n:number}>("SELECT count(*)::int AS n FROM financial_documents WHERE company_id=2")).rows[0].n,0);
  } finally { await db.close(); }
});
