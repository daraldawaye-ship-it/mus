import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { administrativeCustodyTransferSchema as schema } from '../packages/contracts/src/administrative-custody.ts';
import { custodyMedicalBeneficiary, markCustodyMedicalSales } from '../apps/api/src/services/custody-medical-expense.ts';
import { listPouchReceipts } from '../apps/api/src/services/pouch-receipts.ts';
import { accountLinkCategories, accountLinkLabels } from '../packages/contracts/src/masters.ts';

const base = { amount:'100', notes:'', idempotencyKey:randomUUID() };
test('custody expense inputs retain legacy transfers and require a positive integer slip count', () => {
  assert.equal(schema.safeParse({...base,amount:'-12.50'}).success,true);
  for (const slipCount of [0,-1,1.5,2147483648,'2',null,undefined])
    assert.equal(schema.safeParse({...base,expenseKind:'slips',doctorId:1,slipCount}).success,false);
  assert.equal(schema.safeParse({...base,expenseKind:'slips',doctorId:1,slipCount:3}).success,true);
  for (const amount of ['0','0.00','-10'])
    assert.equal(schema.safeParse({...base,expenseKind:'medical',doctorId:1,amount}).success,false);
  assert.equal(schema.safeParse({...base,expenseKind:'medical'}).success,false);
  assert.equal(schema.safeParse({...base,expenseKind:'other',doctorId:1}).success,false);
  assert.equal(accountLinkCategories.medicalSlipsExpense,'expense');
  assert.equal(accountLinkCategories.medicalCommissionExpense,'expense');
  assert.match(accountLinkLabels.medicalCommissionExpense,/أطباء/);
});

test('medical marking includes old child cards, separates tenants/categories, skips slips and rolls back on posting failure', async () => {
  const db=new PGlite();
  try {
    await db.exec(`
      CREATE TABLE users(id integer PRIMARY KEY);
      INSERT INTO users VALUES(1);
      CREATE TABLE doctors(company_id integer,id integer,name text,shared_name text,kind text,active boolean DEFAULT true,PRIMARY KEY(company_id,id));
      CREATE TABLE invoices(company_id integer,id integer,doctor_id integer,kind text,posted boolean,created_at timestamptz,PRIMARY KEY(company_id,id));
      INSERT INTO doctors VALUES
        (2,1,'أحمد صباح','أحمد','nurse',true),(2,2,'أحمد مساء','أحمد','nurse',true),
        (2,3,'د أحمد','أحمد','doctor',true),(2,4,'جهة','جهة','entity',true),
        (3,1,'أحمد','أحمد','nurse',true),(2,5,'قديم','قديم','nurse',false);
      INSERT INTO invoices VALUES
        (2,1,1,'sale',true,'2020-01-01'),(2,2,2,'sale',true,'2026-11-13'),
        (2,3,3,'sale',true,'2026-11-13'),(2,4,1,'sale',false,'2026-11-13'),
        (2,5,1,'purchase',true,'2026-11-13'),(3,1,1,'sale',true,'2026-11-13');
    `);
    await db.exec(await readFile(new URL('../apps/api/migrations/20261107_medical_sales_accounted.sql',import.meta.url),'utf8'));
    const client={query:async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.rows.length};}} as unknown as PoolClient;
    const medical=schema.parse({...base,expenseKind:'medical',doctorId:1});
    const nurse=await custodyMedicalBeneficiary(client,2,medical);
    assert.equal(nurse?.mainName,'أحمد');
    await assert.rejects(()=>custodyMedicalBeneficiary(client,2,{...medical,doctorId:4}));
    await assert.rejects(()=>custodyMedicalBeneficiary(client,2,{...medical,doctorId:5}));
    await assert.rejects(()=>custodyMedicalBeneficiary(client,2,{...medical,doctorId:99}));
    await assert.rejects(()=>custodyMedicalBeneficiary(client,2,{...medical,expenseKind:'slips',doctorId:3,slipCount:1}));
    assert.deepEqual(await markCustodyMedicalSales(client,2,1,nurse,'slips'),{cutoffInvoiceId:null,newlyMarked:0});
    assert.deepEqual((await db.query('SELECT * FROM doctor_sales_accounted_invoices')).rows,[]);
    // Any later posting or receipt failure must roll back classification too.
    await db.exec('BEGIN');
    const rolled=await markCustodyMedicalSales(client,2,1,nurse,'medical');
    assert.equal(rolled.newlyMarked,2);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT * FROM doctor_sales_accounted_invoices')).rows.length,0);
    await db.exec('BEGIN');
    assert.deepEqual(await markCustodyMedicalSales(client,2,1,nurse,'medical'),{cutoffInvoiceId:2,newlyMarked:2});
    await db.exec('COMMIT');
    assert.equal((await markCustodyMedicalSales(client,2,1,nurse,'medical')).newlyMarked,0);
    const marks=await db.query<{invoice_id:number;company_id:number}>('SELECT invoice_id,company_id FROM doctor_sales_accounted_invoices ORDER BY invoice_id');
    assert.deepEqual(marks.rows,[{invoice_id:1,company_id:2},{invoice_id:2,company_id:2}]);
    await db.exec("INSERT INTO invoices VALUES(2,6,1,'sale',true,'2026-11-14')");
    assert.equal((await db.query('SELECT * FROM doctor_sales_accounted_invoices WHERE invoice_id=6')).rows.length,0);
  } finally { await db.close(); }
});

test('migration preserves old transfers and independently stores beneficiary, count and system links', async () => {
  const db=new PGlite();
  try {
    await db.exec(`
      CREATE TABLE users(id integer PRIMARY KEY); INSERT INTO users VALUES(1);
      CREATE TABLE doctors(company_id integer,id integer,PRIMARY KEY(company_id,id));INSERT INTO doctors VALUES(2,1),(2,2);
      CREATE TABLE accounts(company_id integer,id integer,PRIMARY KEY(company_id,id));INSERT INTO accounts VALUES(2,1),(2,2);
      CREATE TABLE financial_documents(company_id integer,id integer,PRIMARY KEY(company_id,id));INSERT INTO financial_documents VALUES(2,1),(2,2),(2,3);
      CREATE TABLE account_links(company_id integer,purpose text CHECK(purpose IN ('administrativeCustody')),account_id integer);
    `);
    await db.exec(await readFile(new URL('../apps/api/migrations/20261107_administrative_custody_transfers.sql',import.meta.url),'utf8'));
    const insert=`INSERT INTO administrative_custody_transfers(company_id,custody_account_id,pouch_account_id,amount,financial_document_id,idempotency_key,request_payload,created_by) VALUES(2,1,2,10,1,'${randomUUID()}','{}',1)`;
    await db.exec(insert);
    await db.exec('CREATE TABLE administrative_custody_receipts(company_id integer,id integer,source_transfer_id integer,mode text,voucher_document_id integer,received_amount numeric,difference_amount numeric,receiver_employee_name text,financial_document_id integer,notes text,created_at timestamptz)');
    await db.exec(await readFile(new URL('../apps/api/migrations/20261113_custody_medical_expenses.sql',import.meta.url),'utf8'));
    assert.equal((await db.query<{expense_kind:string}>('SELECT expense_kind FROM administrative_custody_transfers')).rows[0].expense_kind,'other');
    await db.exec("INSERT INTO account_links VALUES(2,'medicalSlipsExpense',1),(2,'medicalCommissionExpense',2)");
    const medicalInsert=`INSERT INTO administrative_custody_transfers(company_id,custody_account_id,pouch_account_id,amount,financial_document_id,idempotency_key,request_payload,created_by,expense_kind,doctor_id,doctor_name,doctor_main_name,doctor_kind,slip_count) VALUES(2,1,2,10,2,'${randomUUID()}','{}',1,'slips',1,'أحمد','أحمد','nurse',3)`;
    await db.exec(medicalInsert);
    assert.equal((await db.query<{count:number}>('SELECT sum(slip_count)::int AS count FROM administrative_custody_transfers WHERE company_id=2 AND doctor_id=1')).rows[0].count,3);
    const invalidInsert=medicalInsert.replace("10,2,", "10,3,").replace(/'[a-f0-9-]{36}'/,`'${randomUUID()}'`).replace("nurse',3)","nurse',NULL)");
    await assert.rejects(()=>db.exec(invalidInsert));
    await assert.rejects(()=>db.exec('UPDATE administrative_custody_transfers SET slip_count=5 WHERE financial_document_id=2'));
    await db.exec(`
      ALTER TABLE users ADD COLUMN display_name text; UPDATE users SET display_name='الموظف';
      ALTER TABLE accounts ADD COLUMN name text DEFAULT 'القصاصات',ADD COLUMN code text DEFAULT '51001',ADD COLUMN active boolean DEFAULT true,ADD COLUMN kind text DEFAULT 'posting',ADD COLUMN category text DEFAULT 'expense';
      ALTER TABLE financial_documents ADD COLUMN description text DEFAULT 'صرف للقصاصة — أحمد — عدد القصاصات: 3';
      CREATE TABLE employees(company_id integer,id integer,user_id integer,name text,active boolean);
      CREATE TABLE employee_cashbox_operations(company_id integer,id integer,kind text,employee_id integer,employee_name text,amount numeric,notes text,created_at timestamptz,financial_document_id integer,destination_account_id integer);
      CREATE TABLE employee_pouch_receipts(company_id integer,id integer,source_operation_id integer,mode text,voucher_document_id integer,received_amount numeric,difference_amount numeric,receiver_employee_name text,financial_document_id integer,notes text,created_at timestamptz);

    `);
    const client={query:async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.rows.length};}} as unknown as PoolClient;
    const listed=await listPouchReceipts(client,2,'pending',50,0);
    assert.equal(listed.total,2);
    const slip=listed.items.find(row=>row.sourceDocumentId===2)!;
    assert.equal(slip.defaultVoucherAccountId,1);
    assert.equal(slip.defaultVoucherAccountName,'القصاصات');
    assert.match(slip.notes,/عدد القصاصات: 3/);
    assert.equal(listed.items.find(row=>row.sourceDocumentId===1)!.defaultVoucherAccountId,null);
  } finally {await db.close();}
});
