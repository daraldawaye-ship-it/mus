import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import type { PoolClient } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { readAccountLedger } from "../apps/api/src/routes-finance.ts";

test("administrative custody pages newest first without changing chronological balances or other sorts", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE accounts (id int, company_id int, code text, name text, kind text);
    CREATE TABLE financial_documents (id int, company_id int, number text, document_date date,
      kind text, status text, currency_id int, currency_code text, description text, reverses_document_id int);
    CREATE TABLE financial_document_lines (id int, company_id int, account_id int, document_id int,
      line_number int, description text, debit numeric, credit numeric, base_debit numeric,
      base_credit numeric, account_name text);
    CREATE TABLE purchase_correction_journal_dates (company_id int, document_id int, invoice_date date);
    CREATE TABLE employee_cashbox_operations (company_id int, financial_document_id int,
      variance_account_id int, kind text, variance_amount numeric);
    CREATE TABLE finance_settings (company_id int, base_currency_id int);
    CREATE TABLE company_currencies (company_id int, id int, code text);
    INSERT INTO accounts VALUES (1,1,'1111','Custody','posting');
    INSERT INTO finance_settings VALUES (1,1);
    INSERT INTO company_currencies VALUES (1,1,'YER');
    INSERT INTO financial_documents VALUES
      (1,1,'1','2026-11-07','journal','posted',1,'YER','first',NULL),
      (2,1,'2','2026-11-08','journal','posted',1,'YER','middle',NULL),
      (3,1,'3','2026-11-08','journal','posted',1,'YER','last',NULL);
    INSERT INTO financial_document_lines VALUES
      (1,1,1,1,1,'first',10,0,10,0,'Custody'),
      (2,1,1,2,1,'middle',0,3,0,3,'Custody'),
      (3,1,1,3,1,'last start',5,0,5,0,'Custody'),
      (4,1,1,3,2,'last end',0,2,0,2,'Custody');
  `);
  const dbClient = {
    async query(sql: string, params?: unknown[]) {
      const result = await db.query(sql, params);
      return { rows: result.rows, rowCount: result.rows.length };
    },
  } as unknown as PoolClient;
  const read = (mode: Parameters<typeof readAccountLedger>[4], page: number, sort?: string) =>
    readAccountLedger(dbClient, 1, 1, {
      query: { dateFrom: "", dateTo: "", page: String(page), pageSize: "2", ...(sort ? { sort } : {}) },
    } as unknown as Request, mode);
  const values = (result: Awaited<ReturnType<typeof readAccountLedger>>) =>
    result.items.map(row => [row.id, row.runningBalance]);

  const custody = await read("administrativeCustody", 1);
  assert.deepEqual(values(custody), [[4, "10"], [3, "12"]]);
  assert.deepEqual(values(await read("administrativeCustody", 2)), [[2, "7"], [1, "10"]]);
  const cashbox = await read("cashbox", 1);
  assert.deepEqual(values(cashbox), [[1, "10"], [2, "7"]]);
  assert.deepEqual(custody.totals, cashbox.totals);
  assert.deepEqual(values(await read("account", 1)), values(custody));
  assert.deepEqual(values(await read("administrativeCustody", 1, "id:asc")), values(cashbox));
});
