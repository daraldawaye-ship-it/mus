import assert from "node:assert/strict";
import test from "node:test";
import { saleStockQuantity } from "../apps/web/src/sale-stock-quantity.ts";
const item={factor2:7,factor3:3};
test("available sale units use exact integer arithmetic",()=>{
  assert.equal(saleStockQuantity("42",item,1),"2");
  assert.equal(saleStockQuantity("42",item,2),"14");
  assert.equal(saleStockQuantity("42",item,3),"42");
  assert.equal(saleStockQuantity("21",item,2),"7");
  assert.equal(saleStockQuantity("0",item,1),"0");
  assert.equal(saleStockQuantity("2100000000000000000",item,1),"100000000000000000");
  assert.equal(saleStockQuantity("1",item,1),"≈0.0476");
});

test("sales display stock with at most one rounded decimal, without changing exact four-decimal mode",()=>{
  const unit={factor2:2000,factor3:1};
  assert.equal(saleStockQuantity("100247",unit,1),"50.1235");
  assert.equal(saleStockQuantity("100247",unit,1,1),"50.1");
  assert.equal(saleStockQuantity("-100247",unit,1,1),"-50.1");
  assert.equal(saleStockQuantity("100400",unit,1,1),"50.2");
  assert.equal(saleStockQuantity("100000",unit,1,1),"50");
  assert.equal(saleStockQuantity("0",unit,1,1),"0");
  assert.equal(saleStockQuantity("2100000000000000000",unit,3,1),"2100000000000000000");
});
