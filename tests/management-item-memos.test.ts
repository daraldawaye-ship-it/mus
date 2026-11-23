import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { memoCreateSchema } from "../packages/contracts/src/memos.js";

const request = { title:"مذكرة", body:"متابعة", type:"review", idempotencyKey:"feb7f715-6e29-487e-a948-f824f5826340" };
const links = {followPage:null,referencePage:null,itemId:7,accountId:null};
test("an omitted or null recipient requires an actual item reference", () => {
  for (const candidate of [{...request, links},{...request, links, recipientEmployeeId:null},{...request,recipientEmployeeId:1}]) {
    assert.equal(memoCreateSchema.safeParse(candidate).success,true);
  }
  for (const candidate of [request,{...request,links:{...links,itemId:null}},{...request,links,recipientEmployeeId:0}]) {
    assert.equal(memoCreateSchema.safeParse(candidate).success,false);
  }
});

test("administration memos only persist with a linked item in the same transaction", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE items(company_id int,id int,PRIMARY KEY(company_id,id));
    CREATE TABLE memos(company_id int,id int,recipient_employee_id int NOT NULL,
      recipient_user_id int NOT NULL,current_user_id int NOT NULL,current_employee_id int,
      recipient_name text NOT NULL,current_name text NOT NULL,status text NOT NULL DEFAULT 'pending',
      PRIMARY KEY(company_id,id));
    CREATE TABLE memo_links(company_id int,memo_id int,item_id int,PRIMARY KEY(company_id,memo_id),
      FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id),
      FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id));
    INSERT INTO items VALUES (2,7),(3,9);
    INSERT INTO memos VALUES (2,1,4,5,5,4,'موظف','موظف','pending');
  `);
  await db.exec(readFileSync(new URL("../apps/api/migrations/20261123_management_item_memo.sql",import.meta.url),"utf8"));
  const row=(id:number)=>`INSERT INTO memos VALUES (2,${id},NULL,NULL,NULL,NULL,'الإدارة','الإدارة','pending')`;
  await db.transaction(async tx=>{
    await tx.exec(row(2));
    await tx.exec("INSERT INTO memo_links VALUES (2,2,7)");
  });
  await assert.rejects(db.transaction(tx=>tx.exec(row(3))), /requires a company item link/);
  await assert.rejects(db.transaction(tx=>tx.exec("UPDATE memo_links SET item_id=NULL WHERE company_id=2 AND memo_id=2")), /requires a company item link/);
  await assert.rejects(db.transaction(async tx=>{
    await tx.exec(row(4));
    await tx.exec("INSERT INTO memo_links VALUES (2,4,9)");
  }), /foreign key constraint/);
  assert.deepEqual((await db.query("SELECT id, recipient_user_id FROM memos ORDER BY id")).rows,
    [{id:1,recipient_user_id:5},{id:2,recipient_user_id:null}]);
});
