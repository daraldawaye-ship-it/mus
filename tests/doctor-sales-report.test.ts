import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { doctorSalesReportSql } from "../apps/api/src/services/doctor-sales-report.ts";

test("doctor/agency sales report totals posted sales, discounts, returns and currencies", async () => {
 const db=new PGlite();
 try{
  await db.exec(`
   CREATE TABLE doctors(company_id integer,id integer,name text,kind text);
   CREATE TABLE invoices(
    id integer,company_id integer,kind text,posted boolean,document_date date,
    doctor_id integer,doctor_name text,currency_code text,base_currency_code text,
    total numeric,base_total numeric,is_return boolean
   );
   CREATE TABLE legacy_sales_sign_repairs(company_id integer,invoice_id integer,corrected_total numeric);
   INSERT INTO doctors VALUES(2,10,'د. أحمد','doctor'),(2,20,'مستشفى','entity');
   INSERT INTO invoices VALUES
   (1,2,'sale',true,'2026-11-01',10,'د. أحمد','YER','YER',100,100,false),
   (2,2,'sale',true,'2026-11-02',10,'د. أحمد','YER','YER',-20,-20,true),
   (3,2,'sale',true,'2026-11-02',10,'د. أحمد','USD','YER',5,500,false),
   (4,2,'sale',true,'2026-11-02',20,'مستشفى','YER','YER',40,40,false),
   (5,2,'purchase',true,'2026-11-02',10,'د. أحمد','YER','YER',999,999,false),
   (6,2,'sale',false,'2026-11-02',10,'د. أحمد','YER','YER',888,888,false),
   (7,2,'sale',true,'2026-10-01',10,'د. أحمد','YER','YER',999,999,false),
   (8,2,'sale',true,'2026-11-02',null,null,'YER','YER',20,20,false),
   (9,2,'sale',true,'2026-11-02',null,'جهة قديمة','YER','YER',30,30,false),
   (10,2,'sale',true,'2026-11-02',10,'د. أحمد','YER','YER',50,50,false);
   INSERT INTO legacy_sales_sign_repairs VALUES(2,10,-50);
  `);
  const rows=await db.query<Record<string,unknown>>(doctorSalesReportSql,
   [2,"2026-11-01","2026-11-02","%",50,0]);
  assert.equal(rows.rows.length,4);
  const doctor=rows.rows.find(x=>x.doctorKey==="id:10")!;
  assert.equal(Number(doctor.netBaseAmount),530);
  assert.equal(doctor.invoiceCount,4);
  assert.equal(doctor.returnCount,2);
  assert.equal((doctor.currencies as unknown[]).length,2);
  assert.equal(Number(doctor.periodBaseTotal),620);
  assert.equal(doctor.periodInvoiceCount,7);
  const page=await db.query<Record<string,unknown>>(doctorSalesReportSql,
   [2,"2026-11-02","2026-11-02","%",1,0]);
  assert.equal(page.rows.length,1);
  assert.equal(Number(page.rows[0]!.periodBaseTotal),520);
  const searched=await db.query<Record<string,unknown>>(doctorSalesReportSql,
   [2,"2026-11-01","2026-11-02","%مستشفى%",50,0]);
  assert.equal(searched.rows.length,1);
  assert.equal(searched.rows[0]!.doctorKind,"entity");
  assert.equal(Number(searched.rows[0]!.netBaseAmount),40);
 }finally{await db.close();}
});
