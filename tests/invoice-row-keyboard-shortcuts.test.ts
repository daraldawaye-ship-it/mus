import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("apps/web/src/pages/CommercePages.tsx","utf8");
const lineNavStart = source.indexOf("  function nextLine(line?: DraftLine)");
const lineNavEnd = source.indexOf("  function resetInvoiceValues()",lineNavStart);
const lineActions = source.slice(lineNavStart,lineNavEnd);
const tableStart = source.indexOf('<table\n                className={`commerce-lines commerce-matrix');
const rowStart = source.indexOf('data-line-key={line.key}',tableStart);
const rowEnd = source.indexOf('<td className={kind === "sale" ?',rowStart);
const rowKeys = source.slice(rowStart,rowEnd);

test("Delete removes a selected invoice draft row while keeping native Delete in editable fields", () => {
  assert.ok(tableStart > 0 && rowStart > tableStart);
  assert.match(rowKeys,/tabIndex=\{locked \? -1 : 0\}/);
  assert.match(rowKeys,/onClickCapture=\{\(event\) =>/);
  assert.match(rowKeys,/event\.currentTarget\.focus\(\)/);
  assert.match(rowKeys,/onKeyDown=\{\(event\) =>/);
  assert.match(rowKeys,/event\.key === "Delete"/);
  assert.match(rowKeys,/if \(editable && !event\.ctrlKey\) return/);
  assert.match(rowKeys,/event\.preventDefault\(\)/);
  assert.match(rowKeys,/deleteLine\(line\)/);
  assert.match(lineActions,/function deleteLine\(line: DraftLine\)\s*\{\s*if \(locked\) return/);
  assert.match(lineActions,/lines\.filter\(\(entry\) => entry\.key !== line\.key\)/);
  assert.match(lineActions,/remaining\.length \? remaining : \[emptyLine\(\)\]/);
  assert.match(source,/onClick=\{\(\) => deleteLine\(line\)\}/);
});

test("Up/Down navigate draft invoice rows and Down on completed last row adds a new one", () => {
  assert.match(rowKeys,/event\.key !== "ArrowUp" && event\.key !== "ArrowDown"/);
  assert.match(rowKeys,/moveInvoiceLine\(line, event\.key === "ArrowDown" \? 1 : -1, target\)/);
  assert.match(lineActions,/function focusInvoiceLine\(line: DraftLine, source: DraftLine, from: EventTarget \| null\)/);
  assert.match(lineActions,/element\?\.id === lineInputId\(source, "quantity"\)/);
  assert.match(lineActions,/element\?\.id === lineInputId\(source, "price"\)/);
  assert.match(lineActions,/const next = lines\[position \+ direction\]/);
  assert.match(lineActions,/focusInvoiceLine\(next, line, from\)/);
  assert.match(lineActions,/if \(direction < 0\) return/);
  assert.match(lineActions,/if \(!line\.itemId\)/);
  assert.match(lineActions,/nextLine\(line\)/);
  assert.match(lineActions,/if \(line && !validateLine\(line\)\) return/);
  assert.match(lineActions,/selectedLines\.length >= 100/);
  assert.match(lineActions,/setLines\(\(current\) => \[\.\.\.current, created\]\)/);
});

test("item suggestions and native controls retain arrow handling; original invoice rows remain intact", () => {
  assert.match(source,/if \(event\.key === "ArrowDown" && expanded\)/);
  assert.match(source,/if \(event\.key === "ArrowUp" && expanded\)/);
  assert.match(rowKeys,/target\.getAttribute\("aria-expanded"\) === "true"/);
  assert.match(rowKeys,/target\.matches\("select,textarea,button,a"\)/);
  assert.match(rowKeys,/locked \|\| event\.nativeEvent\.isComposing/);
  assert.match(lineActions,/line\.originalSelection \? "original-line" : "item-search"/);
  assert.match(source,/onKeyDownCapture=\{\(event\) => \{/);
  assert.match(source,/event\.key !== "ArrowRight" && event\.key !== "ArrowLeft"/);
});
