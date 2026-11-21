import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { workPanelMovementInvoiceSql } from "../apps/api/src/routes-commerce.ts";

test("workboard invoice lookup uses exact company, item and posted invoice lines with no settlement fallback for purchases", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      CREATE TABLE stock_movements (company_id int, item_id int, id int, invoice_id int, invoice_line_id int, kind text);
      CREATE TABLE invoices (company_id int, id int, kind text, posted bool, supplier_account_name text,
        counterparty_account_name text, total numeric, discount numeric, currency_code text);
      CREATE TABLE invoice_lines (company_id int, invoice_id int, id int, item_id int, total numeric,
        smallest_quantity numeric, factor2 int, factor3 int, unit int, unit_price numeric);
      INSERT INTO invoices VALUES
        (1,2,'sale',true,NULL,'صندوق البيع',700,15,'YER'),
        (1,3,'purchase',true,'المورد الفعلي','صندوق الشراء',300,7,'YER'),
        (1,4,'purchase',true,NULL,'صندوق آخر',200,3,'YER'),
        (1,5,'sale',false,NULL,'مستند غير مرحل',500,5,'YER'),
        (2,2,'sale',true,NULL,'شركة أخرى',900,3,'YER');
      INSERT INTO invoice_lines VALUES
        (1,2,11,8,70,10,2,5,2,7), (1,3,12,8,175,20,2,5,1,80),
        (1,4,13,8,50,5,1,1,1,10), (1,5,14,8,50,5,1,1,1,10),
        (2,2,11,8,70,10,2,5,2,7);
      INSERT INTO stock_movements VALUES
        (1,8,21,2,11,'sale'), (1,8,22,3,12,'purchase_return'), (1,8,23,4,13,'purchase'),
        (1,8,24,5,14,'sale'), (1,8,25,2,11,'reversal'), (1,9,26,2,11,'sale'),
        (1,8,27,3,11,'purchase'), (2,8,28,2,11,'sale'), (1,8,29,2,11,'sale');
    `);
    const r = await db.query(workPanelMovementInvoiceSql, [1, 8, [21,22,23,24,25,26,27,28]]);
    assert.deepEqual(r.rows.sort((a, b) => Number(a.movementId)-Number(b.movementId)), [
      { movementId: 21, invoiceLineId: 11, invoiceId: 2, partyName: "صندوق البيع", unitPriceFirstUnit: "14.00",
        invoiceNet: "700", invoiceDiscount: "15", currencyCode: "YER" },
      { movementId: 22, invoiceLineId: 12, invoiceId: 3, partyName: "المورد الفعلي", unitPriceFirstUnit: "87.5000",
        invoiceNet: "300", invoiceDiscount: "7", currencyCode: "YER" },
      { movementId: 23, invoiceLineId: 13, invoiceId: 4, partyName: null, unitPriceFirstUnit: "10.0000",
        invoiceNet: "200", invoiceDiscount: "3", currencyCode: "YER" },
    ]);
  } finally { await db.close(); }
});
