import test from "node:test";
import assert from "node:assert/strict";
import { balanceItemNamesColumns, createTwoColumnItemNamesPdf } from "../apps/web/src/item-names-pdf.ts";

test("short chosen list starts in two columns, not one tall column", () => {
  const groups = balanceItemNamesColumns([19, 19, 19, 19, 19, 19], 770);
  assert.deepEqual(groups, [{ start: 0, split: 3, end: 6 }]);
});

test("two chosen items occupy right and left columns", () => {
  const groups = balanceItemNamesColumns([20, 20], 770);
  assert.deepEqual(groups, [{ start: 0, split: 1, end: 2 }]);
});

test("single item is never duplicated across both columns", () => {
  assert.deepEqual(balanceItemNamesColumns([20], 770), [
    { start: 0, split: 1, end: 1 },
  ]);
});

test("multiple pages preserve order, cover every item exactly once, and fit columns", () => {
  const heights = Array.from({ length: 130 }, (_, i) => i % 7 === 0 ? 43 : 20);
  const limit = 770;
  const pages = balanceItemNamesColumns(heights, limit);
  assert.ok(pages.length > 1);
  let seen = 0;
  for (const page of pages) {
    assert.equal(page.start, seen);
    assert.ok(page.split >= page.start && page.split <= page.end);
    assert.ok(page.end <= heights.length);
    const rightHeight = heights.slice(page.start, page.split).reduce((a, b) => a + b, 0);
    const leftHeight = heights.slice(page.split, page.end).reduce((a, b) => a + b, 0);
    assert.ok(rightHeight <= limit);
    assert.ok(leftHeight <= limit);
    seen = page.end;
  }
  assert.equal(seen, heights.length);
});

test("mixed long Arabic item names have balanced height rather than item count", () => {
  const heights = [45, 18, 18, 32, 18, 18, 18, 18];
  const pages = balanceItemNamesColumns(heights, 770);
  assert.equal(pages.length, 1);
  const { split } = pages[0];
  const a = heights.slice(0, split).reduce((x, y) => x + y, 0);
  const b = heights.slice(split).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(a - b) <= 23, `imbalanced columns: ${a}, ${b}`);
});


test("PDF draws the required first-unit quantity before the name inside each original column", () => {
  const previous = globalThis.document;
  const drawn: Array<{text:string; x:number; y:number}> = [];
  const ctx = {
    setTransform() {}, fillRect() {}, beginPath() {}, setLineDash() {},
    moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {},
    measureText(value: string) { return {width: value.length * 5}; },
    fillText(text: string, x: number, y: number) { drawn.push({text,x,y}); },
  };
  const canvas = {
    width: 0, height: 0,
    getContext() { return ctx; },
    toDataURL() { return "data:image/jpeg;base64,/9j/2Q=="; },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  try {
    const pdf = createTwoColumnItemNamesPdf([
      {name:"شرائح سكر سيجوي",requiredQuantity:"8"},
      {name:"محلول ملح 500 مل",requiredQuantity:"12"},
    ]);
    assert.equal(pdf.type,"application/pdf");
    const rightQty = drawn.find(x=>x.text==="8");
    const rightName = drawn.find(x=>x.text==="شرائح سكر سيجوي");
    const leftQty = drawn.find(x=>x.text==="12");
    const leftName = drawn.find(x=>x.text==="محلول ملح 500 مل");
    assert.ok(rightQty && rightName && leftQty && leftName);
    assert.ok(rightQty.x > rightName.x,
      "Arabic right-to-left item layout: quantity precedes item name");
    assert.ok(leftQty.x > leftName.x);
    assert.ok(rightQty.x > leftQty.x,
      "Two balanced PDF columns must stay in their old positions");
    drawn.length = 0;
    createTwoColumnItemNamesPdf(["شرائح سكر سيجوي","محلول ملح 500 مل"]);
    assert.equal(drawn.some(x=>x.text==="8"||x.text==="12"),false,
      "Regular names-only PDF remains unchanged");
  } finally {
    Object.defineProperty(globalThis,"document",{
      configurable: true, value: previous,
    });
  }
});
