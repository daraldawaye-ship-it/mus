import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { doctorSalesMovementNamesSql, doctorSalesMovementWhere } from "../apps/api/src/routes-doctor-sales-report.ts";

test("medical movements keep named unclassified cards but exclude entities and blank referrals", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE doctors (id int, company_id int, name text, shared_name text, kind text);
      CREATE TABLE invoices (id int, company_id int, kind text, posted bool, document_date date, doctor_id int);
      CREATE TABLE doctor_sales_accounted_invoices (company_id int, invoice_id int);
      CREATE TABLE legacy_sales_sign_repairs (company_id int, invoice_id int);
      INSERT INTO doctors VALUES
        (1,2,'Doctor','Main doctor','doctor'),(2,2,'Nurse','','nurse'),
        (3,2,'Unclassified','',null),(4,2,'Entity','Main doctor','entity'),
        (5,2,'  ',' ',null),(6,1,'Other company','',null);
      INSERT INTO invoices VALUES
        (1,2,'sale',true,'2026-11-25',1),(2,2,'sale',true,'2026-11-25',2),
        (3,2,'sale',true,'2026-11-25',3),(4,2,'sale',true,'2026-11-25',4),
        (5,2,'sale',true,'2026-11-25',5),(6,2,'sale',true,'2026-11-25',null),
        (7,1,'sale',true,'2026-11-25',6),(8,2,'purchase',true,'2026-11-25',3),
        (9,2,'sale',false,'2026-11-25',3);
    `);
    const names = await db.query(doctorSalesMovementNamesSql, [2,"%"]);
    assert.deepEqual(names.rows, [
      {name:"Main doctor",kinds:["doctor"]},{name:"Nurse",kinds:["nurse"]},
      {name:"Unclassified",kinds:["unassigned"]},
    ]);
    const sql = "SELECT i.id" + doctorSalesMovementWhere + " ORDER BY i.id";
    const query = (name = "", search = "%") => db.query(sql,[2,"2026-11-25","2026-11-25",name,search]);
    assert.deepEqual((await query()).rows, [{id:1},{id:2},{id:3}]);
    assert.deepEqual((await query("Unclassified")).rows, [{id:3}]);
    assert.deepEqual((await query("Main doctor")).rows, [{id:1}]);
    assert.deepEqual((await query("","%Entity%")).rows, []);
    assert.deepEqual((await query("","%Unclass%")).rows, [{id:3}]);
  } finally {
    await db.close();
  }
});
