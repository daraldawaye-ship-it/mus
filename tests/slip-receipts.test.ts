import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import type { User,CompanyContext } from "../packages/contracts/src/index.ts";
import { slipReceiptSchema } from "../packages/contracts/src/slip-receipts.ts";
import { receiveSlips,listSlipMovements,pendingSlips } from "../apps/api/src/services/slip-receipts.ts";
import { assertSlipCashier } from "../apps/api/src/routes-slip-receipts.ts";

test("integer counts and cashier role are enforced",()=>{
  for(const count of [-1,1.5,"13",2147483648,null,undefined])
    assert.equal(slipReceiptSchema.safeParse({count,idempotencyKey:randomUUID()}).success,false);
  for(const count of [0,13,2147483647])
    assert.equal(slipReceiptSchema.safeParse({count,idempotencyKey:randomUUID()}).success,true);
  assert.throws(()=>assertSlipCashier({general:false,employee:{positions:["sales"]}} as CompanyContext));
  assert.doesNotThrow(()=>assertSlipCashier({general:false,employee:{positions:["cashier"]}} as CompanyContext));
});

test("batch reconciliation records 13/14 shortage and 15/14 overage once, preserves tenants, pagination, zero and rollback",async()=>{
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE companies(id integer PRIMARY KEY);INSERT INTO companies VALUES(2),(3);
      CREATE TABLE users(id integer PRIMARY KEY,display_name text);INSERT INTO users VALUES(1,'أمين الصندوق'),(2,'آخر');
      CREATE TABLE administrative_custody_transfers(company_id integer,id integer,expense_kind text,slip_count integer,doctor_name text,created_by integer,created_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id));
      CREATE TABLE page_registry(key text PRIMARY KEY);
      CREATE TABLE audit_events(actor_id integer,actor_name text,scope text,company_id integer,action text,target_type text,target_id integer,before_value jsonb,after_value jsonb);
      CREATE FUNCTION protect_administrative_custody_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;`);
    await db.exec(await readFile(new URL('../apps/api/migrations/20261113_slip_receipts.sql',import.meta.url),'utf8'));
    const client={query:async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.rows.length};}} as unknown as PoolClient;
    const user={id:1,displayName:"أمين الصندوق"} as User;
    await db.exec(`INSERT INTO administrative_custody_transfers(company_id,id,expense_kind,slip_count,doctor_name,created_by) VALUES
      (2,1,'slips',5,'ممرض',1),(2,2,'slips',6,'ممرض',1),(2,3,'slips',2,'ممرض',1),(2,4,'slips',1,'ممرض',1),
      (3,1,'slips',100,'ممرض آخر',1),(2,5,'other',NULL,NULL,1);`);
    const input={count:13,idempotencyKey:randomUUID()};
    async function receive(count:number,key=randomUUID()) {
      await db.exec('BEGIN');
      try{const r=await receiveSlips(client,2,user,{count,idempotencyKey:key});await db.exec('COMMIT');return r;}
      catch(e){await db.exec('ROLLBACK');throw e;}
    }
    const result=await receive(input.count,input.idempotencyKey);
    assert.deepEqual(result,{id:1,expected:'14',received:'13',difference:'-1'});
    assert.deepEqual(await receive(input.count,input.idempotencyKey),result);
    await assert.rejects(()=>receive(15,input.idempotencyKey));
    await assert.rejects(()=>receiveSlips(client,2,{...user,id:2},input));
    await assert.rejects(()=>receive(13)); // another cashier/request cannot take the same batch
    let ledger=await listSlipMovements(client,2,50,0);
    assert.deepEqual(ledger.totals,{transferred:'14',received:'13',shortage:'1',surplus:'0',balance:'0'});
    assert.equal(ledger.items.find(row=>row.kind==='variance')?.negative,'1');
    assert.equal(ledger.items.some(row=>row.actor==='أمين الصندوق'),true);
    assert.equal((await pendingSlips(client,3)).total,'100');
    assert.deepEqual(await pendingSlips(client,2),{count:0,total:'0'});
    await db.exec("INSERT INTO administrative_custody_transfers(company_id,id,expense_kind,slip_count,doctor_name,created_by) VALUES(2,6,'slips',14,'ممرض',1)");
    const over=await receive(15);
    assert.equal(over.difference,'1');
    ledger=await listSlipMovements(client,2,2,0);
    assert.equal(ledger.items.length,2);assert.equal(ledger.total,9);
    assert.deepEqual(ledger.totals,{transferred:'28',received:'28',shortage:'1',surplus:'1',balance:'0'});
    await db.exec("INSERT INTO administrative_custody_transfers(company_id,id,expense_kind,slip_count,doctor_name,created_by) VALUES(2,7,'slips',4,'ممرض',1)");
    // Audit failure rolls back both receipt and all source claims.
    await db.exec("ALTER TABLE audit_events ADD CONSTRAINT reject_receive CHECK(action<>'slips.receive') NOT VALID");
    await assert.rejects(()=>receive(4));
    assert.deepEqual(await pendingSlips(client,2),{count:1,total:'4'});
    await db.exec('ALTER TABLE audit_events DROP CONSTRAINT reject_receive');
    const exact=await receive(4);assert.equal(exact.difference,'0');
    await db.exec("INSERT INTO administrative_custody_transfers(company_id,id,expense_kind,slip_count,doctor_name,created_by) VALUES(2,8,'slips',2,'ممرض',1)");
    assert.equal((await receive(0)).difference,'-2');
    assert.equal((await listSlipMovements(client,2,50,0)).totals.balance,'0');
    await assert.rejects(()=>db.exec('UPDATE slip_receipts SET received_count=99 WHERE id=1'));
    await assert.rejects(()=>db.exec('DELETE FROM slip_receipt_sources WHERE source_id=1'));
  }finally{await db.close();}
});
