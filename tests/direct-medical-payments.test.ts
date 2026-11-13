import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { directMedicalPaymentSchema } from "../apps/api/src/services/direct-medical-payment.ts";
import { pendingSlips, listSlipMovements } from "../apps/api/src/services/slip-receipts.ts";

test("direct cashier expense validates positive amounts, type, beneficiary and integer slip counts", () => {
  const base = { amount:"120.50", notes:"", idempotencyKey:randomUUID(), doctorId:1 };
  assert.equal(directMedicalPaymentSchema.safeParse({...base,expenseKind:"medical"}).success,true);
  assert.equal(directMedicalPaymentSchema.safeParse({...base,expenseKind:"slips",slipCount:2}).success,true);
  for (const invalid of [
    {...base,expenseKind:"other"},
    {...base,expenseKind:"medical",slipCount:1},
    {...base,expenseKind:"slips"},
    {...base,expenseKind:"slips",slipCount:0},
    {...base,expenseKind:"slips",slipCount:2.5},
    {...base,expenseKind:"slips",slipCount:2147483648},
    {...base,expenseKind:"medical",amount:"-10"},
    {...base,expenseKind:"medical",amount:"0"},
    {...base,expenseKind:"medical",doctorId:undefined},
  ])
    assert.equal(directMedicalPaymentSchema.safeParse(invalid).success,false);
});

test("physical slip receipts count custody and direct cashier payments once each", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE users(id integer PRIMARY KEY,display_name text);
      INSERT INTO users VALUES(1,'أمين الصندوق');
      CREATE TABLE administrative_custody_transfers (
        company_id int,id int,expense_kind text,slip_count int,
        created_at timestamptz,created_by int,doctor_name text
      );
      CREATE TABLE direct_medical_payments (
        company_id int,id int,expense_kind text,slip_count int,
        created_at timestamptz,created_by int,doctor_name text
      );
      CREATE TABLE slip_receipt_sources(company_id int,source_id int,receipt_id int);
      CREATE TABLE slip_receipt_direct_sources(company_id int,source_id int,receipt_id int);
      CREATE TABLE slip_receipts(
        company_id int,id int,created_at timestamptz,receiver_name text,
        received_count bigint,difference_count bigint
      );
      INSERT INTO administrative_custody_transfers VALUES
        (2,1,'slips',5,'2026-11-13T06:00:00Z',1,'محمد'),
        (3,2,'slips',99,'2026-11-13T06:10:00Z',1,'خارج الشركة');
      INSERT INTO direct_medical_payments VALUES
        (2,1,'slips',9,'2026-11-13T07:00:00Z',1,'أحمد'),
        (2,2,'medical',NULL,'2026-11-13T07:30:00Z',1,'أحمد');
    `);
    const client={ query:async(sql:string,params?:unknown[]) => {
      const result=await db.query(sql,params);
      return {...result,rowCount:result.rows.length};
    } } as unknown as PoolClient;
    assert.deepEqual(await pendingSlips(client,2),{count:2,total:"14"});
    const before=await listSlipMovements(client,2,50,0);
    assert.equal(before.total,2);
    assert.equal(before.totals.transferred,"14");
    assert.equal(before.pending.total,"14");
    await db.exec(`
      INSERT INTO slip_receipts VALUES(2,1,'2026-11-13T08:00:00Z','أمين الصندوق',13,-1);
      INSERT INTO slip_receipt_sources VALUES(2,1,1);
      INSERT INTO slip_receipt_direct_sources VALUES(2,1,1);
    `);
    assert.deepEqual(await pendingSlips(client,2),{count:0,total:"0"});
    const after=await listSlipMovements(client,2,50,0);
    assert.equal(after.total,4);
    assert.equal(after.totals.transferred,"14");
    assert.equal(after.totals.received,"13");
    assert.equal(after.totals.shortage,"1");
    assert.equal(after.totals.balance,"0");
    assert.equal(after.items.some(row=>row.id==="d:1"),true);
  } finally { await db.close(); }
});
