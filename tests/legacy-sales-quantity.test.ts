import assert from "node:assert/strict";
import test from "node:test";
import { legacySaleInvoiceLines } from "../apps/api/src/services/legacy-sales-quantity.ts";

const system = "dar-aldawa-legacy-2026-10";
const row = (quantity: string) => ({
  "نوع_العمليه": "فاتورة مبيعات",
  "الكمية_المحسوبة_اخيرا": quantity,
});

test("legacy sale stock withdrawals become positive invoice quantities", () => {
  const input = [{ itemId: 1, quantity: "-4.000000", unit: 1 as const }];
  const output = legacySaleInvoiceLines(2, system, "sale", input, [row("-4")]);
  assert.equal(output[0]!.quantity, "4.000000");
  assert.equal(input[0]!.quantity, "-4.000000", "original source payload remains unchanged");
});

test("legacy sale return stocks become negative invoice quantities", () => {
  const output = legacySaleInvoiceLines(2, system, "sale",
    [{quantity:"2.500000"}], [row("2.5")]);
  assert.equal(output[0]!.quantity, "-2.500000");
});

test("mixed legacy sale lines preserve relative signs and all line metadata", () => {
  const input = [{quantity:"-1",unitPrice:"500"},{quantity:"1",unitPrice:"100"}];
  const output = legacySaleInvoiceLines(2,system,"sale",input,[row("-1"),row("1")]);
  assert.deepEqual(output,[{quantity:"1",unitPrice:"500"},{quantity:"-1",unitPrice:"100"}]);
});

test("purchase and nonlegacy batches are unaffected", () => {
  const input=[{quantity:"-4"}];
  assert.equal(legacySaleInvoiceLines(2,system,"purchase",input,[]),input);
  assert.equal(legacySaleInvoiceLines(3,system,"sale",input,[]),input);
  assert.equal(legacySaleInvoiceLines(2,"other-source","sale",input,[]),input);
});

test("client-side pre-flipped or missing rows are rejected", () => {
  assert.throws(()=>legacySaleInvoiceLines(2,system,"sale",
    [{quantity:"4"}],[row("-4")]),/لا تُرحّل الفاتورة/);
  assert.throws(()=>legacySaleInvoiceLines(2,system,"sale",
    [{quantity:"-4"}],[]),/عدد سطور/);
  assert.throws(()=>legacySaleInvoiceLines(2,system,"sale",
    [{quantity:"-4"}],[{"نوع_العمليه":"فاتورة مشتريات","الكمية_المحسوبة_اخيرا":"-4"}]),/لا تُرحّل الفاتورة/);
});
