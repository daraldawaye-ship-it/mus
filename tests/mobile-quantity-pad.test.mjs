import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
const read=(name)=>readFileSync(new URL("../apps/web/src/"+name,import.meta.url),"utf8");

test("compact mobile numeric input opens the existing pad rather than the native keyboard",()=>{
  const code=read("NumericPadField.tsx");
  assert.match(code,/readOnly=\{mobile\|\|input.readOnly\}/);
  assert.match(code,/inputMode=\{mobile\?"none":input.inputMode\}/);
  assert.match(code,/if\(mobile\)\{event.stopPropagation\(\);launch\(event.currentTarget\)/);
  assert.match(code,/\{open&&createPortal\(dialog,document.body\)\}/);
  assert.match(code,/allowDecimal:false,allowNegative:false/);
  assert.match(code,/onChange\(numericPadCommit\(draft, allowEmpty\)\)/);
});
test("all four work-panel quantities are connected to existing validated autosave with blank alert preserved",()=>{
  const code=read("WorkPanelCompactCard.tsx");
  assert.match(code,/compactNumericFields.map[\s\S]*<MobileNumericPadInput/);
  assert.match(code,/allowEmpty=\{key==="orderAlertQuantity"\}/);
  assert.match(code,/onConfirm=\{value=>\{if\(!unavailable\)\{setValue\(key,value\);commit\(key,value\)/);
  assert.match(code,/if \(mobilePad\) return;/);
});
test("same keypad in both order draft layouts keeps lot validation and existing stepper saves",()=>{
  const code=read("pages/ItemOrderDraftsPage.tsx");
  assert.equal([...code.matchAll(/<DraftQuantityInput mobilePad=\{mobilePad\}/g)].length,2);
  assert.match(code,/mobile=\{mobilePad\} maxIntegerDigits=\{16\} onConfirm=\{save\}/);
  assert.match(code,/BigInt\(normalized\) % lot !== 0n/);
  assert.match(code,/if \(onSave\(next.toString\(\)\)\)/);
});
