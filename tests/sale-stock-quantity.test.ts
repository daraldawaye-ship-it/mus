import assert from "node:assert/strict";
import test from "node:test";
import { firstUnitStockText, invoiceSearchStock, saleStockQuantity } from "../apps/web/src/sale-stock-quantity.ts";
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

test("combined first-unit stock displays up to three decimals, including returns and large balances",()=>{
  assert.equal(firstUnitStockText("1333",{factor2:1000,factor3:1}),"1.333");
  assert.equal(firstUnitStockText("4",{factor2:3,factor3:1}),"1.333");
  assert.equal(firstUnitStockText("-4",{factor2:3,factor3:1}),"-1.333");
  assert.equal(firstUnitStockText("11",{factor2:2000,factor3:1}),"0.006");
  assert.equal(firstUnitStockText("2",{factor2:2000,factor3:1}),"0.001");
  assert.equal(firstUnitStockText("1",{factor2:2000,factor3:1}),"0.001");
  assert.equal(firstUnitStockText("0",{factor2:3,factor3:2}),"0");
  assert.equal(firstUnitStockText("40000000000000000000",{factor2:2,factor3:2}),"10000000000000000000");
  assert.equal(firstUnitStockText(null,{factor2:2,factor3:2}),"—");
});

test("invoice search shows first-unit stock rounded to exactly one digit, or permission-redacted",()=>{
  const sample={factor2:2000,factor3:1};
  assert.equal(invoiceSearchStock({...sample,availableSmallest:"100247"}),"50.1");
  assert.equal(invoiceSearchStock({...sample,availableSmallest:"100000"}),"50.0");
  assert.equal(invoiceSearchStock({...sample,availableSmallest:"0"}),"0.0");
  assert.equal(invoiceSearchStock({...sample,availableSmallest:"-100247"}),"-50.1");
  assert.equal(invoiceSearchStock({...sample,availableSmallest:null}),"—");
  assert.equal(invoiceSearchStock({...sample,availableSmallest:undefined}),"—");
});
