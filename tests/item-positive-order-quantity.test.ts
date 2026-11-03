import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { positiveIntegerInput } from "../apps/web/src/positive-integer-input.ts";
import { itemOrderQuantitySchema, itemFactorSchema } from "../packages/contracts/src/items.ts";

test("order quantity and purchase factor are positive integers, defaulting to one", () => {
  assert.equal(itemOrderQuantitySchema.parse("1"),"1");
  assert.equal(itemOrderQuantitySchema.parse("17"),"17");
  assert.equal(itemOrderQuantitySchema.parse("١٢"),"12");
  for(const value of ["0","", "-1","1.5","3e2","abc"]) {
    assert.equal(itemOrderQuantitySchema.safeParse(value).success,false,value);
    assert.equal(itemFactorSchema.safeParse(value).success,false,value);
  }
  assert.equal(itemFactorSchema.parse("1"),1);
  assert.equal(itemFactorSchema.parse("26"),26);
});
test("numeric inputs never leave zero, blank, fractions or negatives in the editor",()=>{
  const max=BigInt("9999999999999999999999");
  assert.equal(positiveIntegerInput("","5",max),"1");
  assert.equal(positiveIntegerInput("0","5",max),"1");
  assert.equal(positiveIntegerInput("-2","5",max),"5");
  assert.equal(positiveIntegerInput("1.4","5",max),"5");
  assert.equal(positiveIntegerInput("٣","5",max),"3");
  assert.equal(positiveIntegerInput("0007","5",max),"7");
  assert.equal(positiveIntegerInput("18","5",max),"18");
  assert.equal(positiveIntegerInput("1000001","5",BigInt(1000000)),"5");
});
test("backfill only repairs zero master order quantities and updates revisions",()=>{
  const sql=readFileSync("apps/api/migrations/20261103_min_one_item_order_quantity.sql","utf8");
  assert.match(sql,/SET order_quantity=1,/);
  assert.match(sql,/revision=revision\+1/);
  assert.match(sql,/WHERE order_quantity=0/);
  assert.match(sql,/ALTER COLUMN order_quantity SET DEFAULT 1/);
  assert.match(sql,/CHECK \(order_quantity>=1\)/);
  assert.ok(!/UPDATE stock_balances|UPDATE invoices|UPDATE stock_movements/.test(sql));
  const ui=readFileSync("apps/web/src/pages/ItemsPages.tsx","utf8");
  assert.match(ui,/positiveIntegerInput\(event\.target\.value, fields\.orderQuantity/);
  assert.match(ui,/positiveIntegerInput\(event\.target\.value, fields\.purchaseFactor/);
});
