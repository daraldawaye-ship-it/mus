import assert from "node:assert/strict";
import { test } from "node:test";
import { adenInvoiceToday, invoiceDateAtSave } from "../apps/web/src/invoice-save-date.ts";
import { resolveInvoicePostingDate } from "../apps/api/src/services/invoice-posting-date.ts";

test("Yemen invoice day changes exactly at midnight (regardless of client timezone)", () => {
  assert.equal(adenInvoiceToday(new Date("2026-11-02T20:59:59.999Z")), "2026-11-02");
  assert.equal(adenInvoiceToday(new Date("2026-11-02T21:00:00.000Z")), "2026-11-03");
  assert.equal(adenInvoiceToday(new Date("2026-12-31T21:00:00.000Z")), "2027-01-01");
});
test("sales and purchase drafts from yesterday use the day of save", () => {
  const at = new Date("2026-11-02T21:05:00.000Z");
  for (const kind of ["sale", "purchase"]) {
    assert.equal(invoiceDateAtSave("2026-11-02", false, at), "2026-11-03", kind);
    assert.equal(invoiceDateAtSave("2026-10-25", false, at), "2026-11-03", kind);
    assert.equal(invoiceDateAtSave("2026-11-03", false, at), "2026-11-03", kind);
  }
});
test("only a permitted explicit date edit preserves another posting date", () => {
  const at = new Date("2026-11-02T21:05:00Z");
  assert.equal(invoiceDateAtSave("2026-11-01", true, at), "2026-11-01");
  assert.equal(invoiceDateAtSave("2026-11-01", false, at), "2026-11-03");
  assert.equal(invoiceDateAtSave("", true, at), "2026-11-03");
});
test("server honors locked date with authoritative posting day and accepted UUID retries", () => {
  assert.equal(resolveInvoicePostingDate("2026-11-02", "2026-11-03", false, null), "2026-11-03");
  assert.equal(resolveInvoicePostingDate("2026-11-02", "2026-11-03", true, null), "2026-11-02");
  assert.equal(resolveInvoicePostingDate("2026-11-02", "2026-11-04", false, "2026-11-03"), "2026-11-03");
  assert.equal(resolveInvoicePostingDate("2026-11-03", "2026-11-04", true, "2026-11-03"), "2026-11-03");
});
