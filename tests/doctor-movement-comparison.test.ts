import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { doctorMovementComparisonSql } from "../apps/api/src/services/doctor-movement-comparison.ts";

test("168-hour medical movement comparison groups shared names and signed net amounts", async()=>{
  const db=new PGlite();
  try{
    await db.exec(`
      CREATE TABLE doctors(company_id integer,id integer,name text,shared_name text,kind text);
      CREATE TABLE invoices(
        id integer,company_id integer,kind text,posted boolean,created_at timestamptz,
        doctor_id integer,doctor_name text,base_total numeric
      );
      CREATE TABLE legacy_sales_sign_repairs(company_id integer,invoice_id integer,corrected_total numeric);
      INSERT INTO doctors VALUES
       (2,10,'احمد فرع أ','الدكتور أحمد','doctor'),
       (2,11,'احمد فرع ب','الدكتور أحمد','doctor'),
       (2,20,'المستشفى','المستشفى','entity');
      INSERT INTO invoices VALUES
       (1,2,'sale',true,now()-interval '1 hour',10,'احمد فرع أ',110),
       (2,2,'sale',true,now()-interval '166 hours',11,'احمد فرع ب',-10),
       (3,2,'sale',true,now()-interval '170 hours',11,'احمد فرع ب',50),
       (4,2,'sale',true,now()-interval '300 hours',10,'احمد فرع أ',30),
       (5,2,'sale',true,now()-interval '200 hours',10,'احمد فرع أ',15),
       (6,2,'sale',true,now()-interval '340 hours',10,'احمد فرع أ',500),
       (7,2,'sale',true,now()-interval '1 hour',20,'المستشفى',20),
       (8,2,'sale',true,now()-interval '200 hours',20,'المستشفى',60),
       (9,2,'purchase',true,now()-interval '1 hour',10,'احمد فرع أ',900),
       (10,2,'sale',false,now()-interval '1 hour',10,'احمد فرع أ',900),
       (11,3,'sale',true,now()-interval '1 hour',10,'احمد فرع أ',900);
      INSERT INTO legacy_sales_sign_repairs VALUES (2,5,-15);
    `);
    const res=await db.query<Record<string,unknown>>(doctorMovementComparisonSql,[2,"%",50,0]);
    assert.equal(res.rows.length,2);
    const doctor=res.rows.find(row=>row.doctorName==="الدكتور أحمد")!;
    assert.equal(Number(doctor.currentAmount),100);
    assert.equal(Number(doctor.previousAmount),65);
    assert.equal(Number(doctor.difference),35);
    const hospital=res.rows.find(row=>row.doctorName==="المستشفى")!;
    assert.equal(Number(hospital.currentAmount),20);
    assert.equal(Number(hospital.previousAmount),60);
    assert.equal(Number(hospital.difference),-40);
    assert.equal(Number(doctor.totalCurrent),120);
    assert.equal(Number(doctor.totalPrevious),125);
    assert.equal(Number(doctor.totalDifference),-5);
    assert.equal(res.rows[0]!.doctorName,"الدكتور أحمد", "numeric differences sort correctly");
    const query=await db.query<Record<string,unknown>>(doctorMovementComparisonSql,[2,"%المستشفى%",1,0]);
    assert.equal(query.rows.length,1);
    assert.equal(Number(query.rows[0]!.totalCurrent),20);
  }finally{await db.close();}
});
