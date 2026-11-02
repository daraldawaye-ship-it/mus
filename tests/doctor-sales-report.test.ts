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
   INSERT INTO doctors VALUES(2,10,'د. أحمد','doctor'),(2,20,'مستشفى','entity'),(2,30,'ممرض سامي','nurse'),(2,40,'غير مصنف مسجل',null);
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
   INSERT INTO invoices VALUES
   (11,2,'sale',true,'2026-11-02',30,'ممرض سامي','YER','YER',15,15,false),
   (12,2,'sale',true,'2026-11-02',40,'غير مصنف مسجل','YER','YER',35,35,false),
   (13,2,'sale',true,'2026-11-02',null,'غير محدد','YER','YER',99,99,false);
   INSERT INTO legacy_sales_sign_repairs VALUES(2,10,-50);
  `);
  const rows=await db.query<Record<string,unknown>>(doctorSalesReportSql,
   [2,"2026-11-01","2026-11-02","%",50,0,false]);
  assert.equal(rows.rows.length,6);
  const doctor=rows.rows.find(x=>x.doctorKey==="id:10")!;
  assert.equal(Number(doctor.netBaseAmount),530);
  assert.equal(doctor.invoiceCount,4);
  assert.equal(doctor.returnCount,2);
  assert.equal((doctor.currencies as unknown[]).length,2);
  assert.equal(Number(doctor.periodBaseTotal),769);
  assert.equal(doctor.periodInvoiceCount,10);
  const page=await db.query<Record<string,unknown>>(doctorSalesReportSql,
   [2,"2026-11-02","2026-11-02","%",1,0,false]);
  assert.equal(page.rows.length,1);
  assert.equal(Number(page.rows[0]!.periodBaseTotal),669);
  const searched=await db.query<Record<string,unknown>>(doctorSalesReportSql,
   [2,"2026-11-01","2026-11-02","%مستشفى%",50,0,false]);
  assert.equal(searched.rows.length,1);
  assert.equal(searched.rows[0]!.doctorKind,"entity");
  assert.equal(Number(searched.rows[0]!.netBaseAmount),40);

  const compact=await db.query<Record<string,unknown>>(doctorSalesReportSql,
   [2,"2026-11-01","2026-11-02","%",50,0,true]);
  assert.equal(compact.rows.length,4, "doctor, nurse, named unclassified and legacy name only");
  assert.deepEqual(new Set(compact.rows.map(row=>row.doctorKey)),
   new Set(["id:10","id:30","id:40","name:جهة قديمة"]));
  assert.equal(compact.rows.some(row=>row.doctorName==="غير محدد"),false);
  assert.equal(compact.rows.some(row=>row.doctorKind==="entity"),false);
  assert.equal(Number(compact.rows[0]!.periodBaseTotal),610);
  const paged=await db.query<Record<string,unknown>>(doctorSalesReportSql,
   [2,"2026-11-01","2026-11-02","%",1,1,true]);
  assert.equal(paged.rows.length,1);
  assert.equal(Number(paged.rows[0]!.periodBaseTotal),610);
 }finally{await db.close();}
});
