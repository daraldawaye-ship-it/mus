import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pageByKey } from "../packages/contracts/src/pages.ts";
import { centralPageAllows } from "../apps/api/src/services/central-access-authorization.ts";
import { medicalPaymentDetailSql, medicalPaymentSummarySql, validMedicalPaymentRange } from "../apps/api/src/services/medical-payment-summary.ts";

import { medicalPaymentTimeLabel } from "../apps/web/src/medical-payment-time.ts";

test("Aden time is displayed in 12-hour Arabic format without a timezone shift", () => {
  assert.deepEqual(medicalPaymentTimeLabel("00:05"), {clock:"12:05", period:"صباحًا"});
  assert.deepEqual(medicalPaymentTimeLabel("09:42"), {clock:"9:42", period:"صباحًا"});
  assert.deepEqual(medicalPaymentTimeLabel("12:00"), {clock:"12:00", period:"مساءً"});
  assert.deepEqual(medicalPaymentTimeLabel("19:42"), {clock:"7:42", period:"مساءً"});
  assert.equal(medicalPaymentTimeLabel(null), null);
  assert.equal(medicalPaymentTimeLabel("24:61"), null);
});
test("report date window allows yesterday through today and up to five days earlier", () => {
  const today = "2026-11-26", earliest = "2026-11-21";
  assert.equal(validMedicalPaymentRange("2026-11-25", today, today, earliest), true);
  assert.equal(validMedicalPaymentRange(today, today, today, earliest), true);
  assert.equal(validMedicalPaymentRange(earliest, today, today, earliest), true);
  assert.equal(validMedicalPaymentRange("2026-11-20", today, today, earliest), false);
  assert.equal(validMedicalPaymentRange(today, "2026-11-27", today, earliest), false);
  assert.equal(validMedicalPaymentRange(today, earliest, today, earliest), false);
});
test("company directory defaults to sales and cashier, with normal central overrides", () => {
  const key = "company.medical-payment-summary";
  assert.equal(pageByKey(key)?.route, "/companies/:companyId/medical-payment-summary");
  const policies = new Map();
  for (const position of ["sales", "cashier"])
    assert.equal(centralPageAllows(policies, key, "view", false, [position]), true);
  for (const positions of [[], ["purchase-entry"], ["employee"]])
    assert.equal(centralPageAllows(policies, key, "view", false, positions), false);
  assert.equal(centralPageAllows(policies, key, "view", true, []), true);
  policies.set("page:" + key, {viewPositions: [], editPositions: []});
  assert.equal(centralPageAllows(policies, key, "view", false, ["sales"]), false);
});
test("only posted medical payments aggregate by main name before numeric sorting", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE users(id int,display_name text);
      INSERT INTO users VALUES (11,'سجل العهدة'),(22,'سجل الصندوق');
      CREATE TABLE doctors(company_id int,id int,name text,shared_name text,kind text);
      CREATE TABLE financial_documents(company_id int,id int,status text,document_date date);
      CREATE TABLE administrative_custody_transfers(company_id int,id int,financial_document_id int,
        expense_kind text,amount numeric,doctor_id int,doctor_main_name text,doctor_name text,doctor_kind text);
      CREATE TABLE direct_medical_payments(LIKE administrative_custody_transfers);
      CREATE TABLE administrative_custody_medical_corrections(company_id int,source_transfer_id int);
      INSERT INTO doctors VALUES (1,1,'فادي الفرع أ','فادي  علي','doctor'),
        (1,2,'فادي الفرع ب','فادي علي','doctor'),(1,3,'سارة','','nurse'),
        (1,4,'جهة','جهة','entity'),(1,5,'غير معين','',NULL),(2,1,'آخر','آخر','doctor');
      INSERT INTO financial_documents VALUES
        (1,1,'posted','2026-11-21'),(1,2,'posted','2026-11-26'),
        (1,3,'posted','2026-11-26'),(1,4,'posted','2026-11-26'),
        (1,5,'posted','2026-11-26'),(1,6,'reversed','2026-11-26'),
        (1,7,'posted','2026-11-20'),(1,8,'posted','2026-11-26'),
        (1,9,'posted','2026-11-26'),(2,1,'posted','2026-11-26'),
        (1,10,'draft','2026-11-26');
      INSERT INTO administrative_custody_transfers VALUES
        (1,1,1,'medical',100.15,1,'قديم','قديم','doctor'),
        (1,2,2,'slips',900,1,'فادي علي','فادي','doctor'),
        (1,3,3,'medical',999,1,'فادي علي','فادي','doctor'),
        (1,4,7,'medical',999,1,'فادي علي','فادي','doctor'),
        (1,5,8,'medical',999,4,'جهة','جهة','doctor'),
        (1,6,9,'medical',999,5,'غير معين','غير معين',NULL),
        (2,1,1,'medical',5000,1,'آخر','آخر','doctor');
      INSERT INTO administrative_custody_medical_corrections VALUES (1,3),(2,1);
      INSERT INTO direct_medical_payments VALUES
        (1,10,4,'medical',200.05,2,'قديم','قديم','doctor'),
        (1,11,5,'medical',80,3,'سارة','سارة','nurse'),
        (1,12,6,'medical',500,3,'سارة','سارة','nurse'),
        (1,13,10,'medical',500,3,'سارة','سارة','nurse');
      ALTER TABLE administrative_custody_transfers ADD COLUMN created_by int DEFAULT 11;
      ALTER TABLE direct_medical_payments ADD COLUMN created_by int DEFAULT 22;
      ALTER TABLE administrative_custody_transfers ADD COLUMN created_at timestamptz DEFAULT '2026-11-21 08:25:40+00';
      ALTER TABLE direct_medical_payments ADD COLUMN created_at timestamptz DEFAULT '2026-11-26 16:42:21+00';
    `);
    type Result = {name:string; movementCount:number; totalAmount:string; periodTotal:string};
    const {rows} = await db.query<Result>(medicalPaymentSummarySql("total", "desc"), [1,"2026-11-21","2026-11-26","%",true]);
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.name, /^فادي +علي$/);
    assert.equal(rows[0]!.movementCount, 2);
    assert.equal(rows[0]!.totalAmount, "300.20");
    assert.equal(rows[0]!.periodTotal, "380.20");
    assert.equal(rows[1]!.name, "سارة");
    assert.equal(rows[1]!.movementCount, 1);
    const asc = await db.query<Result>(medicalPaymentSummarySql("count", "asc"), [1,"2026-11-21","2026-11-26","%",true]);
    assert.equal(asc.rows[0]!.name, "سارة");
    const today = await db.query<Result>(medicalPaymentSummarySql("total","desc"), [1,"2026-11-26","2026-11-26","%",true]);
    assert.equal(today.rows[0]!.totalAmount, "200.05");
    const filtered = await db.query<Result>(medicalPaymentSummarySql("name","asc"), [1,"2026-11-21","2026-11-26","%ادي علي%",true]);
    assert.deepEqual(filtered.rows, [{name:"فادي علي", movementCount:2, totalAmount:"300.20", periodTotal:"300.20"}]);
    const nurse = await db.query<Result>(medicalPaymentSummarySql("name","asc"), [1,"2026-11-21","2026-11-26","%ساره%",true]);
    assert.equal(nurse.rows[0]!.name, "سارة");
    const employee = await db.query<Result>(medicalPaymentSummarySql("total","desc"), [1,"2026-11-21","2026-11-26","%",false]);
    assert.equal(employee.rows[0]!.totalAmount, "300.20");
    assert.ok(employee.rows.every(row => row.periodTotal === null));

    const detail = await db.query(medicalPaymentDetailSql, [1,"2026-11-21","2026-11-26","فادي علي"]);
    assert.deepEqual(detail.rows, [
      {date:"2026-11-26", time:"19:42", amount:"200.05", actor:"سجل الصندوق"}, {date:"2026-11-21", time:"11:25", amount:"100.15", actor:"سجل العهدة"},
    ]);
    const partial = await db.query(medicalPaymentDetailSql, [1,"2026-11-21","2026-11-26","فادي"]);
    assert.equal(partial.rows.length, 0);

  } finally { await db.close(); }
});
