import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { assertThirdPartyGoodsAccount } from "../apps/api/src/services/third-party-goods.ts";
import { salesTimeReportSql } from "../apps/api/src/routes-sales-time-report.ts";

test("third-party invoice guard and time report preserve mixed lines, returns and company isolation", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE items(company_id integer,id integer);
      CREATE TABLE option_definitions(id integer,company_id integer,key text,record_kind text,active boolean,default_value jsonb);
      CREATE TABLE option_values(company_id integer,definition_id integer,record_kind text,item_id integer,account_id integer,value jsonb);
      CREATE TABLE accounts(company_id integer,id integer,cash_or_bank boolean);
      CREATE TABLE invoices(id integer,company_id integer,kind text,posted boolean,document_date date,created_at timestamptz,
        base_currency_code text,exchange_rate numeric,base_decimal_places integer,counterparty_account_id integer);
      CREATE TABLE invoice_lines(company_id integer,invoice_id integer,item_id integer,base_total numeric,discount numeric);
      CREATE TABLE legacy_sales_sign_repairs(company_id integer,invoice_id integer);
      INSERT INTO items VALUES(2,1),(2,2),(2,3),(3,1);
      INSERT INTO option_definitions VALUES
        (10,2,'items.third-party-goods','item',true,'false'),
        (9,2,'accounts.third-party-goods-account','account',true,'false'),
        (30,3,'items.third-party-goods','item',true,'true');
      INSERT INTO option_values VALUES(2,10,'item',2,null,'true'),(2,10,'item',3,null,'false'),
        (2,9,'account',null,20,'true');
      INSERT INTO accounts VALUES(2,10,true),(2,20,false),(3,10,true);
      INSERT INTO invoices VALUES
        (1,2,'sale',true,'2026-11-13','2026-11-13T07:00:00Z','YER',1,2,10),
        (2,2,'sale',true,'2026-11-14','2026-11-14T08:00:00Z','YER',1,2,20),
        (3,2,'sale',false,'2026-11-14','2026-11-14T08:00:00Z','YER',1,2,20),
        (4,3,'sale',true,'2026-11-14','2026-11-14T08:00:00Z','YER',1,2,10),
        (5,2,'purchase',true,'2026-11-14','2026-11-14T08:00:00Z','YER',1,2,20);
      INSERT INTO invoice_lines VALUES(2,1,1,90,10),(2,1,2,45,5),(2,1,2,-10,0),
        (2,2,1,-20,0),(2,2,2,30,0),(2,3,1,999,0),(3,4,1,999,0),(2,5,1,999,0);
    `);
    const client = db as unknown as PoolClient;
    await assertThirdPartyGoodsAccount(client,2,10,[1,3]);
    await assertThirdPartyGoodsAccount(client,2,20,[2]);
    await assert.rejects(assertThirdPartyGoodsAccount(client,2,20,[1,2]),
      (error: any) => error.code === "third_party_goods_only");
    await assert.rejects(assertThirdPartyGoodsAccount(client,2,20,[1]));
    await assert.rejects(assertThirdPartyGoodsAccount(client,2,10,[1,2]),
      (error: any) => error.code === "third_party_goods_account_required");
    await assert.rejects(assertThirdPartyGoodsAccount(client,2,999,[2]));
    await assertThirdPartyGoodsAccount(client,3,10,[999]);
    const report = async (include = false, weekdays = [0,1,2,3,4,5,6], payment = "all") => {
      const result = await db.query<any>(salesTimeReportSql,[2,"2026-11-13","2026-11-14",payment,include,weekdays]);
      return result.rows.find(row => row.level === 3);
    };
    const hidden = await report();
    assert.equal(Number(hidden.gross),100);
    assert.equal(Number(hidden.discount),10);
    assert.equal(Number(hidden.returns),20);
    assert.equal(Number(hidden.net),70);
    const shown = await report(true);
    assert.equal(Number(shown.gross),180);
    assert.equal(Number(shown.discount),15);
    assert.equal(Number(shown.returns),30);
    assert.equal(Number(shown.net),135);
    assert.equal(Number((await report(false,[5])).net),90); // Friday
    assert.equal(Number((await report(false,[6])).net),-20); // Saturday
    assert.equal(await report(false,[]),undefined);
    assert.equal(Number((await report(false,undefined,"cash")).net),90);
    assert.equal(Number((await report(false,undefined,"credit")).net),-20);
    await db.exec(`UPDATE option_definitions SET default_value='true' WHERE id=10`);
    await assert.rejects(assertThirdPartyGoodsAccount(client,2,10,[1]));
    await assertThirdPartyGoodsAccount(client,2,10,[3]); // explicit false overrides default
    await db.exec(`UPDATE option_definitions SET active=false WHERE id=10`);
    await assertThirdPartyGoodsAccount(client,2,10,[2]);
  } finally { await db.close(); }
});
