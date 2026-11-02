import assert from "node:assert/strict";
import test from "node:test";
import { invoiceSideElapsed, invoiceSideDateTime } from "../apps/web/src/invoice-side-time.ts";
import { readFileSync } from "node:fs";

test("invoice sidebar shows hours and minutes elapsed from current time", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.equal(invoiceSideElapsed("2026-11-02T09:43:00Z", now), "منذ 2 ساعة و17 دقيقة");
  assert.equal(invoiceSideElapsed("2026-11-02T11:45:00Z", now), "منذ 15 دقيقة");
  assert.equal(invoiceSideElapsed("2026-11-02T12:00:00Z", now), "الآن");
  assert.equal(invoiceSideElapsed("2026-11-02T12:05:00Z", now), "الآن");
  assert.equal(invoiceSideElapsed("2026-10-31T11:45:00Z", now), "منذ 48 ساعة و15 دقيقة");
});

test("invoice sidebar date and time use Yemen local 12-hour clock with ص/م", () => {
  assert.equal(invoiceSideDateTime("2026-11-02T08:30:00Z"), "02/11/2026 11:30 ص");
  assert.equal(invoiceSideDateTime("2026-11-02T10:30:00Z"), "02/11/2026 1:30 م");
  assert.equal(invoiceSideDateTime("2026-11-02T21:05:00Z"), "03/11/2026 12:05 ص");
  assert.equal(invoiceSideDateTime("2026-11-02T09:00:00Z"), "02/11/2026 12:00 م");
});

test("all invoice side event rows show relative duration over smaller dated time", () => {
  const ui = readFileSync("apps/web/src/InvoiceSideOverview.tsx", "utf8");
  const css = readFileSync("apps/web/src/styles.css", "utf8");
  assert.match(ui, /function EventTimestamp/);
  assert.match(ui, /invoiceSideElapsed\(value, nowMs\)/);
  assert.match(ui, /invoiceSideDateTime\(value\)/);
  assert.match(ui, /setInterval\(\(\) => setClockNow\(Date\.now\(\)\), 60_000\)/);
  assert.match(ui, /<EventTimestamp value=\{entry\.createdAt\} nowMs=\{clockNow\} \/>/);
  assert.match(ui, /<EventTimestamp value=\{row\.lastCheckedInAt\} nowMs=\{clockNow\} \/>/);
  assert.match(css, /\.invoice-side-event-datetime\s*\{[^}]*font-size:\s*9px/s);
  assert.doesNotMatch(ui, /hour12:\s*false/);
});

test("cashbox shortage and surplus closes show exact date and 12-hour time only, last 14 hours", () => {
  const ui = readFileSync("apps/web/src/InvoiceSideOverview.tsx", "utf8");
  const css = readFileSync("apps/web/src/styles.css", "utf8");
  assert.match(ui, /آخر 14 ساعة/);
  assert.doesNotMatch(ui, /آخر 3 أيام/);
  const begin = ui.indexOf("transfers.data.closings.items.map");
  const end = ui.indexOf("</tbody>", begin);
  assert.ok(begin > 0 && end > begin, "closing rows should exist");
  const closingRows = ui.slice(begin, end);
  assert.match(closingRows, /<time dateTime=\{entry\.createdAt\} className="invoice-side-closing-datetime">/);
  assert.match(closingRows, /invoiceSideDateTime\(entry\.createdAt\)/);
  assert.doesNotMatch(closingRows, /EventTimestamp|invoiceSideElapsed|منذ/);
  assert.match(css, /\.invoice-side-closing-datetime\s*\{/);
  const transfersStart = ui.indexOf("section.items.map");
  const transfersEnd = ui.indexOf("</tbody>", transfersStart);
  assert.match(ui.slice(transfersStart, transfersEnd),
    /<EventTimestamp value=\{entry\.createdAt\} nowMs=\{clockNow\} \/>/);
  assert.match(ui, /<EventTimestamp value=\{row\.lastCheckedInAt\} nowMs=\{clockNow\} \/>/);
});
