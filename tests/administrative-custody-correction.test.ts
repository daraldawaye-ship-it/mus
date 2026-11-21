import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import { administrativeCustodyTransferSchema } from "../packages/contracts/src/administrative-custody.ts";
import { custodyCorrectionCandidatesSql, custodyMedicalCorrectionLines, postCustodyMedicalCorrection } from "../apps/api/src/services/administrative-custody-correction.ts";
import { moneyUnits } from "../apps/api/src/services/finance.ts";

test("negative medical correction requires explicit source and reason; slips are unchanged", () => {
  const input = { amount: "-3000", expenseKind: "medical", doctorId: 22, notes: "صرف مكرر",
    idempotencyKey: "e995da73-5d0e-4eaf-8c6a-341be9495dd1", correctionSourceId: 421 };
  assert.equal(administrativeCustodyTransferSchema.safeParse(input).success, true);
  for (const change of [{ correctionSourceId: undefined }, { notes: " " }, { doctorId: undefined },
    { amount: "-0.00" }, { amount: "3000" }, { expenseKind: "slips", slipCount: 5 },
    { expenseKind: "other", doctorId: undefined }]) {
    assert.equal(administrativeCustodyTransferSchema.safeParse({...input, ...change}).success, false);
  }
  assert.equal(administrativeCustodyTransferSchema.safeParse({
    ...input, amount: "3000", correctionSourceId: undefined,
  }).success, true);
  const correction = custodyMedicalCorrectionLines(11, 12, moneyUnits("3000"), "reason");
  assert.deepEqual(correction.map(({accountId,debit,credit})=>[accountId,moneyUnits(debit),moneyUnits(credit)]),
    [[11,moneyUnits("3000"),0n],[12,0n,moneyUnits("3000")]]);
});

test("candidates exclude received, previously corrected, settled, unrelated, and unposted transfers; mapping is immutable", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      CREATE TABLE users(id integer PRIMARY KEY);
      INSERT INTO users VALUES(1);
      CREATE TABLE financial_documents(company_id integer,id integer,number text,status text,kind text,currency_code text,
        reversal_document_id integer,reverses_document_id integer, currency_id integer DEFAULT 5,PRIMARY KEY(company_id,id));
      CREATE TABLE administrative_custody_transfers(company_id integer,id integer,financial_document_id integer,
        doctor_id integer,expense_kind text,amount numeric,accounted_invoice_count integer,
        notes text DEFAULT '',created_at timestamptz DEFAULT now(),custody_account_id integer DEFAULT 11,
        pouch_account_id integer DEFAULT 12,PRIMARY KEY(company_id,id));
      CREATE TABLE finance_settings(company_id integer,base_currency_id integer);
      INSERT INTO finance_settings VALUES(1,5),(2,5);
      CREATE TABLE financial_document_lines(company_id int, document_id int, account_id int, debit numeric, credit numeric);
      INSERT INTO financial_document_lines VALUES(1,1,11,0,2999),(1,1,12,2999,0);
      CREATE TABLE administrative_custody_receipts(company_id integer,source_transfer_id integer);
      CREATE FUNCTION protect_administrative_custody_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE='23514'; END $$;
      INSERT INTO financial_documents
        SELECT 1,i,'000000000'||i,CASE WHEN i=8 THEN 'draft' ELSE 'posted' END,'journal','YER',NULL,NULL
        FROM generate_series(1,10) i;
      INSERT INTO financial_documents VALUES (2,1,'0000000011','posted','journal','YER',NULL,NULL);
      INSERT INTO administrative_custody_transfers(company_id,id,financial_document_id,doctor_id,expense_kind,amount,accounted_invoice_count)
        VALUES (1,1,1,22,'medical',3000,0),(1,2,2,22,'medical',3000,0),(1,3,3,22,'medical',3000,0),
          (1,4,4,22,'medical',3000,1),(1,5,5,23,'medical',3000,0),(1,6,6,22,'slips',3000,0),
          (1,7,7,22,'medical',-3000,0),(1,8,8,22,'medical',3000,0),(2,1,1,22,'medical',3000,0);
      INSERT INTO administrative_custody_receipts VALUES (1,2),(2,1);
    `);
    await db.exec(await readFile(new URL("../apps/api/migrations/20261121_zz_custody_medical_corrections.sql", import.meta.url), "utf8"));
    await db.exec(`INSERT INTO administrative_custody_medical_corrections
      (company_id,source_transfer_id,financial_document_id,idempotency_key,request_payload,created_by)
      VALUES (1,3,9,'978bcad4-7898-43a0-b37d-3c5b842d9fe0','{}',1)`);
    const candidates = await db.query<{ id: number; documentNumber: string }>(custodyCorrectionCandidatesSql, [1,22]);
    assert.equal(candidates.rows.length,1);
    assert.equal(candidates.rows[0].id,1);
    assert.equal(candidates.rows[0].documentNumber,"0000000001");
    const client = {query: db.query.bind(db)} as unknown as PoolClient;
    const input = administrativeCustodyTransferSchema.parse({
      amount: "-3000", expenseKind: "medical", doctorId: 22, notes: "صرف مكرر", correctionSourceId: 1,
      idempotencyKey: "b8159aba-0a2b-42c6-ad02-ce1ebac8f799",
    });
    const user = {id: 1} as User;
    for (const bad of [{ amount: "-2999" }, { correctionSourceId: 2 }, { correctionSourceId: 3 },
      { correctionSourceId: 4 }, { doctorId: 23 }]) {
      await assert.rejects(postCustodyMedicalCorrection(client, 1, user, {...input,...bad}),
        {code:"custody_correction_unavailable"});
    }
    await assert.rejects(postCustodyMedicalCorrection(client, 1, user, input),
      {code:"custody_correction_journal_mismatch"});

    await assert.rejects(db.exec("DELETE FROM administrative_custody_medical_corrections"), {code:"23514"});
    await assert.rejects(db.exec(`INSERT INTO administrative_custody_medical_corrections
      (company_id,source_transfer_id,financial_document_id,idempotency_key,request_payload,created_by)
      VALUES (1,3,10,'978bcad4-7898-43a0-b37d-3c5b842d9fe1','{}',1)`), {code:"23505"});
  } finally { await db.close(); }
});

test("real isolated posting reverses only selected custody journal, preserves marks, and safely replays", async () => {
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { readdir } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { postCommerceJournal } = await import("../apps/api/src/services/commerce-ledger.ts");
  const { postAdministrativeCustodyTransfer } = await import("../apps/api/src/services/administrative-custody.ts");
  const { listPouchReceipts, receivePouchMovement } = await import("../apps/api/src/services/pouch-receipts.ts");
  const db = await PGlite.create({extensions: {pg_trgm}});
  try {
    const directory = new URL("../apps/api/migrations/", import.meta.url);
    const paths = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    // Historic deployed transfer migration is already present before its
    // receipts dependency; replicate that existing prerequisite in a fresh fixture.
    const transfers = "20261107_administrative_custody_transfers.sql";
    const receipts = "20261107_administrative_custody_receipts.sql";
    if (paths.indexOf(transfers) > paths.indexOf(receipts)) {
      paths.splice(paths.indexOf(transfers), 1);
      paths.splice(paths.indexOf(receipts), 0, transfers);
    }
    for (const name of paths) await db.exec(await readFile(new URL(name, directory), "utf8"));
    await db.exec(`
      INSERT INTO users(name,display_name,email,password_hash,kind,owner)
        VALUES('Fixture','Fixture','fixture@example.test','fixture','admin',true);
      INSERT INTO companies(name,created_by) VALUES('Fixture',1);
      INSERT INTO company_currencies(company_id,code,name,decimal_places,created_by) VALUES(1,'YER','YER',2,1)
        ON CONFLICT(company_id,code) DO NOTHING;
      INSERT INTO finance_settings(company_id,base_currency_id)
        SELECT 1,id FROM company_currencies WHERE company_id=1 AND code='YER'
        ON CONFLICT(company_id) DO UPDATE SET base_currency_id=excluded.base_currency_id;
      INSERT INTO accounts(company_id,code,name,kind,category,normal_side,created_by)
        VALUES (1,'0000009001','Custody','posting','asset','debit',1),(1,'0000009002','Pouch','posting','asset','debit',1);
      INSERT INTO doctors(company_id,name,kind,created_by) VALUES(1,'Fixture doctor','doctor',1);
    `);
    const client = {query: async (sql:string,p?:unknown[]) => {
      const result = await db.query(sql,p);
      return {...result,rowCount:result.rows.length || result.affectedRows || 0};
    }} as unknown as PoolClient;
    const user = {id:1,displayName:"Fixture",owner:true} as User;
    const accounts = (await db.query<{id:number}>("SELECT id FROM accounts WHERE company_id=1 AND code IN ('0000009001','0000009002') ORDER BY code")).rows.map(row=>row.id);
    const [custody,pouch] = accounts as [number,number];
    const currencyId=(await db.query<{base_currency_id:number}>("SELECT base_currency_id FROM finance_settings WHERE company_id=1")).rows[0]!.base_currency_id;
    const doctorId=(await db.query<{id:number}>("SELECT id FROM doctors WHERE company_id=1")).rows[0]!.id;
    const makeOriginal = async () => {
      await db.exec("BEGIN");
      const documentId=await postCommerceJournal(client,1,user,{
        documentDate:"2026-11-21",branchId:null,currencyId,description:"Original fixture",
        idempotencyKey:randomUUID(), lines:[
          {accountId:custody,debit:"0",credit:"3000",description:"Custody"},
          {accountId:pouch,debit:"3000",credit:"0",description:"Pouch"},
        ],
      });
      const r=await db.query<{id:number}>(`INSERT INTO administrative_custody_transfers
        (company_id,custody_account_id,pouch_account_id,amount,financial_document_id,idempotency_key,
          request_payload,created_by,expense_kind,doctor_id,doctor_name,doctor_main_name,doctor_kind)
        VALUES(1,$1,$2,3000,$3,$4,'{}',1,'medical',$5,'Fixture doctor','Fixture doctor','doctor') RETURNING id`,
        [custody,pouch,documentId,randomUUID(),doctorId]);
      await db.exec("COMMIT");
      return {id:r.rows[0]!.id,documentId};
    };
    const good = await makeOriginal(), duplicate = await makeOriginal();
    const before = await db.query("SELECT * FROM administrative_custody_transfers ORDER BY id");
    const markers = await db.query("SELECT * FROM doctor_sales_accounted_invoices");
    assert.deepEqual((await listPouchReceipts(client,1,"pending",50,0)).items.map(x=>x.id).sort(),[good.id,duplicate.id]);
    const input = administrativeCustodyTransferSchema.parse({amount:"-3000",doctorId,expenseKind:"medical",
      correctionSourceId:duplicate.id,notes:"Duplicate confirmed",idempotencyKey:randomUUID()});
    await db.exec("BEGIN");
    const result=await postAdministrativeCustodyTransfer(client,1,user,input);
    await db.exec("COMMIT");
    assert.equal(result.operationId,duplicate.id);
    const journal = await db.query<{account_id:number;debit:string;credit:string}>(
      "SELECT account_id,debit::text,credit::text FROM financial_document_lines WHERE company_id=1 AND document_id=$1 ORDER BY line_number",
      [result.documentId]);
    assert.deepEqual(journal.rows.map(row=>[row.account_id,moneyUnits(row.debit),moneyUnits(row.credit)]),
      [[custody,moneyUnits("3000"),0n],[pouch,0n,moneyUnits("3000")]]);
    assert.deepEqual((await db.query("SELECT * FROM administrative_custody_transfers ORDER BY id")).rows,before.rows);
    assert.deepEqual((await db.query("SELECT * FROM doctor_sales_accounted_invoices")).rows,markers.rows);
    const pending=await listPouchReceipts(client,1,"pending",50,0);
    assert.deepEqual(pending.items.map(x=>x.id),[good.id]);
    await db.exec("BEGIN");
    await assert.rejects(receivePouchMovement(client,1,user,{
      sourceKind:"custody",sourceOperationId:duplicate.id,mode:"exact",notes:"",idempotencyKey:randomUUID(),
    }),{code:"pouch_movement_corrected"});
    await db.exec("ROLLBACK");
    await db.exec("BEGIN");
    assert.deepEqual(await postAdministrativeCustodyTransfer(client,1,user,input),result);
    await db.exec("COMMIT");
    await db.exec("BEGIN");
    await assert.rejects(postAdministrativeCustodyTransfer(client,1,user,{...input,idempotencyKey:randomUUID()}),
      {code:"custody_correction_unavailable"});
    await db.exec("ROLLBACK");
    assert.equal((await db.query("SELECT 1 FROM administrative_custody_medical_corrections")).rows.length,1);
  } finally { await db.close(); }
});
