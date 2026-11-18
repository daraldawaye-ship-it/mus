import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { doctorMovementComparisonSql, sortedDoctorMovementComparisonSql } from "../apps/api/src/services/doctor-movement-comparison.ts";

test("168-hour medical movement comparison groups shared names and signed net amounts", async()=>{
  const db=new PGlite();
  try{
    await db.exec(`
      CREATE TABLE doctors(company_id integer,id integer,name text,shared_name text,kind text,department text,phone text,active boolean);
      CREATE TABLE invoices(
        id integer,company_id integer,kind text,posted boolean,created_at timestamptz,
        doctor_id integer,doctor_name text,base_total numeric
      );
      CREATE TABLE legacy_sales_sign_repairs(company_id integer,invoice_id integer,corrected_total numeric);
      CREATE TABLE financial_documents(company_id integer,id integer,status text);
      CREATE TABLE administrative_custody_transfers(
        id integer,company_id integer,expense_kind text,amount numeric,
        doctor_id integer,doctor_main_name text,created_at timestamptz,financial_document_id integer
      );
      CREATE TABLE direct_medical_payments(
        id integer,company_id integer,expense_kind text,amount numeric,
        doctor_id integer,doctor_main_name text,created_at timestamptz,financial_document_id integer
      );
      INSERT INTO doctors VALUES
       (2,10,'الدكتور أحمد','الدكتور أحمد','doctor','قسم أ','711111111',true),
       (2,11,'احمد فرع ب','الدكتور أحمد','doctor','قسم ب','722222222',true),
       (2,20,'المستشفى','المستشفى','nurse','قسم الطوارئ','733333333',true);
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
      INSERT INTO financial_documents VALUES
        (2,201,'posted'),(2,202,'posted'),(2,203,'posted'),
        (2,204,'posted'),(2,205,'posted'),(2,206,'posted'),
        (2,207,'posted'),(2,208,'posted'),(2,209,'draft');
      INSERT INTO administrative_custody_transfers VALUES
        (1,2,'medical',40,10,'الدكتور أحمد',now()-interval '2 hours',201),
        (2,2,'medical',15,11,'الدكتور أحمد',now()-interval '200 hours',202),
        (3,2,'slips',7,20,'المستشفى',now()-interval '3 hours',203),
        (4,2,'other',888,10,'الدكتور أحمد',now()-interval '1 hour',204),
        (5,2,'medical',999,10,'الدكتور أحمد',now()-interval '340 hours',205);
      INSERT INTO direct_medical_payments VALUES
        (1,2,'medical',60,11,'الدكتور أحمد',now()-interval '1 hour',206),
        (2,2,'medical',20,10,'الدكتور أحمد',now()-interval '260 hours',207),
        (3,2,'slips',9,20,'المستشفى',now()-interval '205 hours',208),
        (4,2,'medical',900,10,'الدكتور أحمد',now()-interval '1 hour',209);
    `);
    const res=await db.query<Record<string,unknown>>(doctorMovementComparisonSql,[2,"%",50,0,true]);
    assert.equal(res.rows.length,2);
    const doctor=res.rows.find(row=>row.doctorName==="الدكتور أحمد")!;
    assert.equal(Number(doctor.currentAmount),100);
    assert.equal(Number(doctor.previousAmount),65);
    assert.equal(Number(doctor.difference),35);
    assert.equal(doctor.category,"doctor");
    assert.equal(doctor.department,"قسم أ","metadata follows the primary shared-name card");
    assert.equal(doctor.phone,"711111111");
    assert.equal(Number(doctor.paidCurrent),100,"custody plus direct commissions only");
    assert.equal(Number(doctor.paidPrevious),35);
    assert.equal(Number(doctor.slipsCurrent),0);
    assert.equal(Number(doctor.slipsPrevious),0);
    const hospital=res.rows.find(row=>row.doctorName==="المستشفى")!;
    assert.equal(Number(hospital.currentAmount),20);
    assert.equal(Number(hospital.previousAmount),60);
    assert.equal(Number(hospital.difference),-40);
    assert.equal(Number(hospital.slipsCurrent),7);
    assert.equal(Number(hospital.slipsPrevious),9);
    assert.equal(Number(hospital.paidCurrent),0);
    assert.equal(Number(doctor.totalCurrent),120);
    assert.equal(Number(doctor.totalPrevious),125);
    assert.equal(Number(doctor.totalDifference),-5);
    assert.equal(res.rows[0]!.doctorName,"الدكتور أحمد", "numeric differences sort correctly");
    const query=await db.query<Record<string,unknown>>(doctorMovementComparisonSql,[2,"%المستشفى%",1,0,true]);
    assert.equal(query.rows.length,1);
    assert.equal(Number(query.rows[0]!.totalCurrent),20);
    const lowest=await db.query<Record<string,unknown>>(sortedDoctorMovementComparisonSql("difference","asc"),[2,"%",1,0,true]);
    assert.equal(lowest.rows[0]!.doctorName,"المستشفى");
    const previousHigh=await db.query<Record<string,unknown>>(sortedDoctorMovementComparisonSql("previousAmount","desc"),[2,"%",1,0,true]);
    assert.equal(previousHigh.rows[0]!.doctorName,"الدكتور أحمد");
    const alpha=await db.query<Record<string,unknown>>(sortedDoctorMovementComparisonSql("doctorName","asc"),[2,"%",1,0,true]);
    assert.equal(alpha.rows[0]!.doctorName,"الدكتور أحمد");
    // A very large signed number must be ordered by PostgreSQL numeric, not lexicographically.
    assert.match(sortedDoctorMovementComparisonSql("currentAmount","desc"),/ORDER BY compared.current_amount DESC/);
    const payouts=await db.query<Record<string,unknown>>(sortedDoctorMovementComparisonSql("paidCurrent","desc"),[2,"%",2,0,true]);
    assert.equal(payouts.rows[0]!.doctorName,"الدكتور أحمد");
    const unauthorized=await db.query<Record<string,unknown>>(doctorMovementComparisonSql,[2,"%",50,0,false]);
    assert.equal(unauthorized.rows.length,2,"sales still available without finance rights");
    assert.equal(unauthorized.rows[0]!.paidCurrent,null);
    assert.equal(unauthorized.rows[0]!.slipsPrevious,null);

  }finally{await db.close();}
});
