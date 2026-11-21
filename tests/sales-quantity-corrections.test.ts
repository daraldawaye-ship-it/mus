import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import type { User } from "../packages/contracts/src/index.ts";
import {
  assertSalesCorrectionAccess,listSalesQuantityCorrections,patchSalesQuantityCorrection,salesCorrectionPatchSchema,
} from "../apps/api/src/services/sales-quantity-corrections.ts";
import { manualSalesQuantityActivitySql } from "../apps/api/src/services/staged-activity-sql.ts";

test("signed correction syntax supports both directions, explicit zero and clear; no reasonless writes",()=>{
  const base={sourceKey:'["posted", 11]',reason:"مراجعة المصدر",expectedRevision:0};
  assert.equal(salesCorrectionPatchSchema.parse({...base,correctedQuantity:"−٢.٥"}).correctedQuantity,"-2.5");
  assert.equal(salesCorrectionPatchSchema.parse({...base,correctedQuantity:"+0"}).correctedQuantity,"+0");
  assert.equal(salesCorrectionPatchSchema.parse({...base,correctedQuantity:null}).correctedQuantity,null);
  for(const correctedQuantity of ["","  ","1e3","-","1.00001"]) {
    assert.equal(salesCorrectionPatchSchema.safeParse({...base,correctedQuantity}).success,false);
  }
  assert.equal(salesCorrectionPatchSchema.safeParse({...base,reason:"",correctedQuantity:"0"}).success,false);
});

test("manual quantities keep periods, signed direction, source identities and accounting separate",async()=>{
  const db=await PGlite.create();
  try {
    await db.exec(`
      CREATE TABLE companies(id int PRIMARY KEY); INSERT INTO companies VALUES(1),(2);
      CREATE TABLE users(id int PRIMARY KEY); INSERT INTO users VALUES(1),(2);
      CREATE TABLE items(company_id int,id int,unit1_name text,factor2 int,factor3 int,PRIMARY KEY(company_id,id));
      INSERT INTO items VALUES(1,8,'علبة',2,5),(1,9,'آخر',2,5),(2,8,'خارج',2,5);
      CREATE TABLE invoices(company_id int,id int,posted bool,kind text,document_date date,number text);
      CREATE TABLE invoice_lines(company_id int,id int,invoice_id int,item_id int,line_number int,
        smallest_quantity numeric,factor2 int,factor3 int,unit int,unit_name text);
      INSERT INTO invoices VALUES (1,10,true,'sale','2026-11-05','I10'),(1,20,true,'sale','2025-05-01','I20'),
        (1,30,true,'purchase','2026-11-05','P30'),(2,10,true,'sale','2026-11-05','OTHER');
      INSERT INTO invoice_lines VALUES (1,11,10,8,1,20,2,5,1,'علبة'),(1,21,20,8,1,10,2,5,1,'علبة'),
        (1,31,30,8,1,12,2,5,1,'علبة'),(2,11,10,8,1,20,2,5,1,'خارج');
      CREATE TABLE legacy_sales_sign_repairs(company_id int,invoice_id int,line_snapshots jsonb);
      CREATE TABLE transaction_source_imports(company_id int,invoice_id int,source_system text,source_kind text,source_id text);
      CREATE TABLE staged_invoice_item_lines_cache(company_id int,source_system text,source_kind text,source_id text,
        line_number int,document_date date,kind text,item_id int,quantity numeric,unit int);
      INSERT INTO staged_invoice_item_lines_cache VALUES
        (1,'legacy','invoice','pending',1,'2026-09-05','sale',8,2,2),
        (1,'legacy','invoice','ambiguous',1,'2026-09-05','sale',8,2,1),
        (1,'legacy','invoice','ambiguous',2,'2026-09-05','sale',8,2,2),
        (1,'legacy','invoice','wrong-item',1,'2026-02-05','sale',8,2,2);
      CREATE TABLE staged_invoice_item_contributions(company_id int,source_system text,source_kind text,source_id text,
        item_id int,positive_quantity numeric,negative_quantity numeric);
      INSERT INTO staged_invoice_item_contributions VALUES (1,'legacy','invoice','pending',8,10,0),
        (1,'legacy','invoice','ambiguous',8,30,0),(1,'legacy','invoice','wrong-item',8,10,0);
      CREATE TABLE audit_events(actor_id int,actor_name text,scope text,company_id int,action text,target_type text,
        target_id int,before_value jsonb,after_value jsonb);
      CREATE TABLE stock_balances(qty int); INSERT INTO stock_balances VALUES (99);
      CREATE TABLE financial_documents(amount int); INSERT INTO financial_documents VALUES (500);
      CREATE TABLE financial_document_lines(debit int,credit int); INSERT INTO financial_document_lines VALUES(500,0),(0,500);
    `);
    await db.exec(await readFile(new URL("../apps/api/migrations/20261121_zzzz_sales_quantity_corrections.sql",import.meta.url),"utf8"));
    const client={query:async(sql:string,params?:unknown[])=>{
      const r=await db.query(sql,params);return {...r,rowCount:r.rows.length||r.affectedRows||0};
    }} as unknown as PoolClient;
    const owner={id:1,displayName:"Fixture",owner:true} as User;
    await assert.rejects(assertSalesCorrectionAccess(client,{...owner,owner:false},1),{code:"sales_correction_owner"});
    const rows=await listSalesQuantityCorrections(client,1,8,{page:1,pageSize:20});
    assert.equal(rows.items.length,6);
    const key=(type:string,...parts:(string|number)[])=>JSON.stringify([type,...parts]).replaceAll(",",", ");
    const posted=key("posted",11), old=key("posted",21), staged=key("legacy","legacy","pending",1);
    const change=(sourceKey:string,correctedQuantity:string|null,expectedRevision=0,itemId=8)=>
      patchSalesQuantityCorrection(client,owner,1,itemId,salesCorrectionPatchSchema.parse({
        sourceKey,correctedQuantity,reason:"معايرة موثقة",expectedRevision,
      }));
    assert.equal(rows.items.find(r=>r.sourceKey===posted).originalQuantity,"2");
    assert.equal(rows.items.find(r=>r.sourceKey===staged).originalQuantity,"1");
    assert.equal(rows.items.find(r=>r.sourceKey===key("legacy","legacy","ambiguous",1)).originalQuantity,null);
    await assert.rejects(change(key("legacy","legacy","ambiguous",1),"1"),{code:"sales_correction_unit_unknown"});
    await assert.rejects(change(posted,"1",0,9),{code:"sales_correction_source_missing"});
    await assert.rejects(change(key("posted",31),"1"),{code:"sales_correction_source_missing"});
    assert.equal((await change(posted,"-0.5")).correctedQuantity,"-0.5");
    assert.equal((await change(staged,"+3")).correctedQuantity,"3");
    assert.equal((await change(old,"0")).correctedQuantity,"0");
    await assert.rejects(change(posted,"4",0),{code:"sales_correction_conflict"});

    const withPeriods=async()=> (await db.query<{period:string;sold:string;returned:string;count:string}>(`
      WITH periods(period,begin) AS (VALUES('month',DATE '2026-10-22'),('four',DATE '2026-07-22'),
        ('year',DATE '2025-11-22'),('all',DATE '1900-01-01')),
      correction AS (${manualSalesQuantityActivitySql("$2::date")}),
      activity AS (
        SELECT document_date,sale_quantity,sale_return_quantity,sale_invoices FROM correction WHERE item_id=8
        UNION ALL SELECT * FROM (VALUES (DATE '2026-11-05',20::numeric,0::numeric,1::bigint),
          (DATE '2026-09-05',10,0,1),(DATE '2025-05-01',10,0,1)) raw(day,sold,returned,count)
      )
      SELECT p.period,trim_scale(sum(a.sale_quantity))::text AS sold,
       trim_scale(sum(a.sale_return_quantity))::text AS returned,sum(a.sale_invoices)::text AS count
      FROM periods p JOIN activity a ON a.document_date>=p.begin GROUP BY p.period ORDER BY p.period`,[1,"2026-11-21"])).rows;
    assert.deepEqual(await withPeriods(),[
      {period:"all",sold:"30",returned:"5",count:"3"},{period:"four",sold:"30",returned:"5",count:"2"},
      {period:"month",sold:"0",returned:"5",count:"1"},{period:"year",sold:"30",returned:"5",count:"2"},
    ]);
    // A repaired posted sale is already a return in the official reports.
    // The manual delta must subtract that return, not the original sale.
    await db.exec(`INSERT INTO invoices VALUES(1,60,true,'sale','2026-11-02','FIX60'),(1,61,true,'sale','2026-11-02','FIX61');
      INSERT INTO invoice_lines VALUES(1,61,60,8,1,15,2,5,2,'شريط'),(1,62,61,8,1,15,2,5,2,'شريط');
      INSERT INTO legacy_sales_sign_repairs VALUES
        (1,60,'[{"lineNumber":1,"smallestQuantity":"-15"}]'),
        (1,61,'[{"lineNumber":1,"smallestQuantity":"-15"},{"lineNumber":1,"smallestQuantity":"-15"}]');`);
    assert.equal((await listSalesQuantityCorrections(client,1,8,{page:1,pageSize:20})).items
      .find(row=>row.sourceKey===key("posted",61)).originalQuantity,"-1.5");
    await assert.rejects(change(key("posted",62),"1"),{code:"sales_correction_unit_unknown"});
    assert.equal((await change(key("posted",61),"2")).correctedQuantity,"2");
    assert.deepEqual((await db.query(`SELECT trim_scale(sale_quantity)::text AS sold,trim_scale(sale_return_quantity)::text AS returned
      FROM sales_quantity_activity_deltas WHERE document_date=DATE '2026-11-02'`)).rows,[{sold:"20",returned:"-15"}]);
    assert.equal((await change(key("posted",61),null,1)).correctedQuantity,null);
    const before=await withPeriods();
    const wrongItem=key("legacy","legacy","wrong-item",1);
    assert.equal((await change(wrongItem,"5")).correctedQuantity,"5");
    assert.equal((await db.query(`SELECT 1 FROM sales_quantity_activity_deltas
      WHERE company_id=1 AND item_id=8 AND document_date=DATE '2026-02-05'`)).rows.length,1);
    await db.exec(`
      INSERT INTO invoices VALUES(1,40,true,'sale','2026-09-05','I40'),(1,41,true,'sale','2026-02-05','I41');
      INSERT INTO invoice_lines VALUES(1,41,40,8,1,10,2,5,2,'شريط'),(1,42,41,9,1,10,2,5,2,'شريط');
      INSERT INTO transaction_source_imports VALUES(1,40,'legacy','invoice','pending'),(1,41,'legacy','invoice','wrong-item');
    `);
    // Even if the staged cache lags deletion, the posted identity wins once.
    assert.deepEqual(await withPeriods(),before);
    const promoted=(await listSalesQuantityCorrections(client,1,8,{page:1,pageSize:20})).items.filter(r=>r.sourceKey===staged);
    assert.equal(promoted.length,1);
    assert.equal(promoted[0].sourceKind,"posted");
    assert.equal(promoted[0].correctedQuantity,"3");
    await assert.rejects(change(wrongItem,"5",1),{code:"sales_correction_source_missing"});
    assert.equal((await change(posted,null,1)).correctedQuantity,null);
    assert.equal((await withPeriods()).find(row=>row.period==="month")?.sold,"20");
    assert.equal((await db.query("SELECT 1 FROM audit_events")).rows.length,7);
    assert.deepEqual((await db.query("SELECT qty FROM stock_balances")).rows,[{qty:99}]);
    assert.deepEqual((await db.query("SELECT amount FROM financial_documents")).rows,[{amount:500}]);
    assert.deepEqual((await db.query("SELECT debit,credit FROM financial_document_lines ORDER BY debit")).rows,[{debit:0,credit:500},{debit:500,credit:0}]);
  }finally { await db.close(); }
});
