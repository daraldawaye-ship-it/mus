import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { workPanelMovementInvoiceSql, workPanelStaffMovementInvoiceSql } from "../apps/api/src/routes-commerce.ts";

test("workboard invoice lookup uses exact company, item and posted invoice lines with no settlement fallback for purchases", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      CREATE TABLE items (id int, company_id int, active bool);
      INSERT INTO items VALUES (8,1,true),(8,2,false),(8,3,true);
      CREATE TABLE stock_movements (company_id int, item_id int, id int, invoice_id int, invoice_line_id int, kind text, quantity_smallest numeric);
      CREATE TABLE invoices (company_id int, id int, kind text, posted bool, supplier_account_name text,
        counterparty_account_name text, total numeric, discount numeric, currency_code text, decimal_places int);
      CREATE TABLE invoice_lines (company_id int, invoice_id int, id int, item_id int, total numeric,
        smallest_quantity numeric, factor2 int, factor3 int, unit int, unit_price numeric, gross numeric, discount numeric);
      INSERT INTO invoices VALUES
        (1,2,'sale',true,NULL,'صندوق البيع',700,15,'YER',0),
        (1,3,'purchase',true,'المورد الفعلي','صندوق الشراء',300,7,'YER',0),
        (1,4,'purchase',true,NULL,'صندوق آخر',200,3,'YER',0),
        (1,5,'sale',false,NULL,'مستند غير مرحل',500,5,'YER',0),
        (2,2,'sale',true,NULL,'شركة أخرى',900,3,'YER',0);
      INSERT INTO invoice_lines VALUES
        (1,2,11,8,1400,3,1,1,1,500,1500,100), (1,3,12,8,-160,-20,2,5,1,85,-170,-10),
        (1,4,13,8,50,5,1,1,1,10,50,0), (1,5,14,8,50,5,1,1,1,10,50,0),
        (2,2,11,8,70,10,2,5,2,7,70,0), (1,2,15,8,-60,-1,4,5,3,70,-70,-10);
      INSERT INTO stock_movements VALUES
        (1,8,21,2,11,'sale',-1), (1,8,22,3,12,'purchase_return',-20), (1,8,23,4,13,'purchase',5),
        (1,8,24,5,14,'sale',-5), (1,8,25,2,11,'reversal',1), (1,9,26,2,11,'sale',-19),
        (1,8,27,3,11,'purchase',20), (2,8,28,2,11,'sale',-10), (1,8,29,2,11,'sale',-2), (1,8,30,2,15,'sales_return',1);
    `);
    const r = await db.query<{ movementId: number }>(workPanelMovementInvoiceSql, [1, 8, [21,22,23,24,25,26,27,28,30]]);
    assert.deepEqual(r.rows.sort((a, b) => Number(a.movementId)-Number(b.movementId)), [
      { movementId: 21, invoiceLineId: 11, invoiceId: 2, partyName: "صندوق البيع", postedUnitPrice: "500",
        firstUnitMultiplier: "1", unitPriceFirstUnit:"500", lineValue:"500", invoiceDiscount:"15", invoiceNet:"700" },
      { movementId: 22, invoiceLineId: 12, invoiceId: 3, partyName: "المورد الفعلي", postedUnitPrice: "85",
        firstUnitMultiplier: "10", unitPriceFirstUnit:"85", lineValue:"-170", invoiceDiscount:"7", invoiceNet:"300" },
      { movementId: 23, invoiceLineId: 13, invoiceId: 4, partyName: null, postedUnitPrice: "10",
        firstUnitMultiplier: "1", unitPriceFirstUnit:"10", lineValue:"50", invoiceDiscount:"3", invoiceNet:"200" },
      { movementId: 30, invoiceLineId: 15, invoiceId: 2, partyName: "صندوق البيع", postedUnitPrice: "70",
        firstUnitMultiplier: "20", unitPriceFirstUnit:"1400", lineValue:"-70", invoiceDiscount:"15", invoiceNet:"700" },
    ]);
    const visible = (await db.query<Record<string, unknown>>(workPanelStaffMovementInvoiceSql,[1,8,[21,22,30]])).rows;
    assert.equal(visible.length,3);
    assert.ok(visible.every(row => !("partyName" in row) && !("lineNet" in row)
      && "invoiceDiscount" in row && "invoiceNet" in row));
    assert.deepEqual((await db.query(workPanelStaffMovementInvoiceSql,[2,8,[28]])).rows,[]);
    assert.deepEqual((await db.query(workPanelStaffMovementInvoiceSql,[3,8,[21]])).rows,[]);
    const remainder = (await db.query<{ lineValue: string; invoiceDiscount: string; invoiceNet: string }>(workPanelMovementInvoiceSql,[1,8,[29]])).rows[0];
    assert.deepEqual([remainder.lineValue,remainder.invoiceDiscount,remainder.invoiceNet],["1000","15","700"]);
  } finally { await db.close(); }
});
