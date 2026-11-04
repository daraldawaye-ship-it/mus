import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read=(path:string)=>readFileSync(path,"utf8");

test("purchase price fields re-select after grouped monetary formatting is removed on focus",()=>{
  const ui=read("apps/web/src/ui.tsx");
  const commerce=read("apps/web/src/pages/CommercePages.tsx");
  const field=ui.slice(ui.indexOf("export function Field({"),ui.indexOf("export function Select({"));
  assert.match(field,/selectOnFocus = false/);
  assert.match(field,/money && value !== null && value !== undefined/);
  assert.match(field,/!focused \|\| props\.readOnly/);
  assert.match(field,/useLayoutEffect\(\(\) => \{/);
  assert.match(field,/if \(!selectOnFocus \|\| !focused\) return/);
  assert.match(field,/document\.activeElement === input/);
  assert.match(field,/input\.select\(\)/);
  assert.match(field,/\[selectOnFocus, focused\]/,
    "Selection must happen once per focus transition rather than on each keystroke");
  assert.ok(field.indexOf("useLayoutEffect") < field.indexOf("return ("),
    "post-render selection belongs to reusable Field component");
  const price=commerce.slice(commerce.indexOf('id={lineInputId(line, "price")}'));
  assert.match(price,/selectOnFocus=\{kind === "purchase" && !line\.originalLineId\}/);
  assert.match(price,/money/);
  assert.match(price,/onFocus=\{\(event\) => event\.target\.select\(\)\}/);
  assert.match(commerce,/focus\(lineInputId\(line, "price"\)\)/);
});

test("browser focus regression covers short and long purchase prices and entire selection range",()=>{
  const browser=read("tests/browser-invoice-focus.ts");
  assert.match(browser,/purchasePrice\.fill\("12345"\)/);
  assert.match(browser,/value: "12345", start: 0, end: 5/);
  assert.match(browser,/purchasePrice\.fill\("123"\)/);
  assert.match(browser,/value: "123", start: 0, end: 3/);
  assert.match(browser,/purchaseQuantity\.press\("Enter"\)/);
});
