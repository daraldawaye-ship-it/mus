import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { stockMovementNotesAccess, stockMovementNotesSql } from "../apps/api/src/services/stock-movement-notes.ts";
import { searchPattern } from "../apps/api/src/services/lists.ts";

const source = (key: string, view = true) => ({
  key, actionAccess: { view, create: false, edit: false, post: false, reverse: false, print: false },
});
const bothInvoices = [source("company.invoice"), source("company.sales"), source("company.purchases")];

test("stock movement source notes require the related page and respect explicit denials", () => {
  assert.deepEqual(stockMovementNotesAccess([source("company.stock-movements")], new Map(), false), {
    sale: false, purchase: false, operation: false,
  });
  assert.deepEqual(stockMovementNotesAccess([source("company.sales")], new Map(), true), {
    sale: false, purchase: false, operation: false,
  });
  assert.deepEqual(stockMovementNotesAccess(bothInvoices, new Map(), false), {
    sale: false, purchase: false, operation: false,
  });
  assert.deepEqual(stockMovementNotesAccess([
    ...bothInvoices, source("company.stock-operations"),
  ], new Map([["company.purchases:view", "deny"]]), true), {
    sale: true, purchase: false, operation: true,
  });
});

test("stock movement notes search uses the displayed value before pagination with company-scoped sources", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE moves (id int, company_id int, invoice_id int, operation_id int);
    CREATE TABLE invoices (id int, company_id int, kind text, description text);
    CREATE TABLE stock_operations (id int, company_id int, description text);
    INSERT INTO moves VALUES (1,1,10,NULL),(2,1,20,NULL),(3,1,NULL,20),(4,1,NULL,10),(5,1,NULL,30);
    INSERT INTO invoices VALUES (10,1,'sale','ملاحظة بيع ABC_123'),(20,1,'purchase','ملاحظة شراء ABC_123');
    INSERT INTO stock_operations VALUES (20,1,'ملاحظة مناقلة ABC_123'),(10,2,'ملاحظة مخفية ABC_123'),(30,1,'ABCX123');
  `);
  const query = async (access: ReturnType<typeof stockMovementNotesAccess>, offset: number) => {
    const { join, value } = stockMovementNotesSql(access);
    return (await db.query<{ id: number; notes: string }>(`
      SELECT m.id,${value} AS notes FROM moves m
      LEFT JOIN invoices doctor_invoice ON doctor_invoice.company_id=m.company_id AND doctor_invoice.id=m.invoice_id
      ${join} WHERE m.company_id=1 AND ${value} ILIKE $1
      ORDER BY m.id DESC LIMIT 1 OFFSET $2
    `, [searchPattern("ABC_123"), offset])).rows;
  };
  const access = { sale: true, purchase: false, operation: true };
  assert.deepEqual(await query(access, 0), [{ id: 3, notes: "ملاحظة مناقلة ABC_123" }]);
  assert.deepEqual(await query(access, 1), [{ id: 1, notes: "ملاحظة بيع ABC_123" }]);
  assert.deepEqual(await query(access, 2), []);
  assert.deepEqual(await query({ sale: false, purchase: false, operation: false }, 0), []);
});
