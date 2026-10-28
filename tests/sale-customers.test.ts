import test from "node:test";
import assert from "node:assert/strict";
import { invoiceSchema } from "../packages/contracts/src/commerce.ts";
import { saleCustomerInputSchema } from "../packages/contracts/src/sale-customers.ts";

const input={
  idempotencyKey:"123e4567-e89b-42d3-a456-426614174000",
  kind:"sale" as const,documentDate:"2026-10-29",
  currencyId:1,branchId:1,locationId:1,counterpartyAccountId:1,
  doctorId:null,doctorName:"",
  supplierAccountId:null,supplierReceiptNumber:"",
  description:"",discount:"0",
  lines:[{itemId:1,unit:1 as const,quantity:"1",unitPrice:"10",expiryDate:null,originalLineId:null}],
};

test("customer number preserves leading zeroes and can be searched as text",()=>{
  assert.equal(saleCustomerInputSchema.parse({customerNumber:"000012",name:"عميل"}).customerNumber,"000012");
});
test("sales customer fields are optional",()=>{
  const result=invoiceSchema.safeParse(input);
  assert.equal(result.success,true);
  if(result.success)assert.equal(result.data.saleCustomerNumber,"");
});
test("new customer may have number and name",()=>{
  assert.equal(invoiceSchema.safeParse({...input,saleCustomerNumber:"123",saleCustomerName:"عميل جديد"}).success,true);
});
test("name cannot be saved without a customer number",()=>{
  assert.equal(invoiceSchema.safeParse({...input,saleCustomerName:"عميل بلا رقم"}).success,false);
});
test("purchase invoice rejects sale customer fields",()=>{
  assert.equal(invoiceSchema.safeParse({...input,kind:"purchase",saleCustomerNumber:"12",saleCustomerName:"عميل"}).success,false);
});
