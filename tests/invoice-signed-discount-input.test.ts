import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  calculateInvoiceTotals, invoiceDiscountSchema, invoiceQuantitySchema,
} from "../packages/contracts/src/commerce.ts";
import {
  enteredInvoiceQuantity, enteredInvoiceDiscount, completedInvoiceDiscount,
} from "../apps/web/src/invoice-number-input.ts";

test("quantity never stays blank, zero, or alphabetic while typing", () => {
  assert.equal(enteredInvoiceQuantity(""), "1");
  assert.equal(enteredInvoiceQuantity("  "), "1");
  assert.equal(enteredInvoiceQuantity("-"), "-1");
  assert.equal(enteredInvoiceQuantity("0"), "1");
  assert.equal(enteredInvoiceQuantity("-0"), "-1");
  assert.equal(enteredInvoiceQuantity("١٢"), "12");
  assert.equal(enteredInvoiceQuantity("-٣"), "-3");
  assert.equal(enteredInvoiceQuantity("12a"), null);
  assert.equal(enteredInvoiceQuantity("abc"), null);
  assert.equal(enteredInvoiceQuantity("1.4"), null);
  assert.equal(enteredInvoiceQuantity("1,000"), null);
  assert.equal(invoiceQuantitySchema.parse(enteredInvoiceQuantity("  ")!), "1");
});
test("discount stays numeric, resets to zero and permits negative entry", () => {
  assert.equal(enteredInvoiceDiscount(""), "0");
  assert.equal(enteredInvoiceDiscount(" "), "0");
  assert.equal(enteredInvoiceDiscount("-"), "-0");
  assert.equal(enteredInvoiceDiscount("-200"), "-200");
  assert.equal(enteredInvoiceDiscount("-٠٠٢.٥"), "-2.٥".replace("٥", "5"));
  assert.equal(enteredInvoiceDiscount("-0."), "-0.");
  assert.equal(completedInvoiceDiscount("-0."), "0");
  assert.equal(completedInvoiceDiscount("25."), "25");
  assert.equal(enteredInvoiceDiscount("5a"), null);
  assert.equal(enteredInvoiceDiscount("a5"), null);
  assert.equal(enteredInvoiceDiscount("5.1234567"), null);
  assert.equal(invoiceDiscountSchema.parse("-0.5"), "-0.5");
});
test("signed discount increases a normal sale's net, positive discount reduces it", () => {
  const line = [{quantity:"1",unitPrice:"100"}];
  assert.deepEqual(
    calculateInvoiceTotals(line, "-20", 2),
    {gross:"100",discount:"-20",total:"120",lineDiscounts:["-20"],lineTotals:["120"]},
  );
  const positive=calculateInvoiceTotals(line,"20",2);
  assert.equal(positive.total,"80");
  assert.equal(positive.discount,"20");
});
test("negative fractional discount keeps its sign even below one rial", () => {
  const result=calculateInvoiceTotals([{quantity:"1",unitPrice:"100"}],"-0.5",2);
  assert.equal(result.total,"100.5");
  assert.equal(result.discount,"-0.5");
  assert.deepEqual(result.lineTotals,["100.5"]);
});
test("negative discounts distribute exactly across separate sale lines", () => {
  const result=calculateInvoiceTotals([
    {quantity:"1",unitPrice:"40"},{quantity:"1",unitPrice:"60"},
  ],"-35",2);
  assert.equal(result.gross,"100");
  assert.equal(result.total,"135");
  assert.deepEqual(result.lineDiscounts,["-14","-21"]);
  assert.deepEqual(result.lineTotals,["54","81"]);
});
test("returns retain their negative stock direction and cannot carry standalone header discount", () => {
  const result=calculateInvoiceTotals([
    {quantity:"1",unitPrice:"50"},
    {quantity:"-1",unitPrice:"20",discount:"-5"},
  ],"-10",2);
  assert.equal(result.gross,"30");
  assert.equal(result.discount,"-15");
  assert.equal(result.total,"45");
  assert.deepEqual(result.lineTotals,["60","-15"]);
  assert.throws(()=>calculateInvoiceTotals([{quantity:"-1",unitPrice:"20"}],"-2",2));
});
test("strict accounting schema still rejects signed prices and invalid input", () => {
  assert.throws(()=>invoiceDiscountSchema.parse("-2x"));
  assert.throws(()=>calculateInvoiceTotals([{quantity:"1",unitPrice:"-5"}],"0",2));
  assert.throws(()=>calculateInvoiceTotals([{quantity:"1",unitPrice:"100"}],"101",2));
});
test("database migration preserves existing invoice validation and routes negative discount to income", () => {
  const sql=readFileSync("apps/api/migrations/172_signed_invoice_header_discount.sql","utf8");
  const server=readFileSync("apps/api/src/services/commerce.ts","utf8");
  const editor=readFileSync("apps/web/src/pages/CommercePages.tsx","utf8");
  assert.match(sql,/invoice_lines_signed_amounts_check/);
  assert.match(sql,/pg_get_functiondef\('check_invoice_integrity\(\)'::regprocedure\)/);
  assert.match(server,/discount > 0n \? "discountAllowed" : "discountEarned"/);
  assert.match(editor,/enteredInvoiceQuantity\(rawValue\)/);
  assert.match(editor,/enteredInvoiceDiscount\(event.target.value\)/);
  assert.match(editor,/onBlur=\{\(\) => setDiscount\(current => completedInvoiceDiscount\(current\)\)\}/);
});
