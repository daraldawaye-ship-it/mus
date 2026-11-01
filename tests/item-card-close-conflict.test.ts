import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page=readFileSync("apps/web/src/pages/ItemsPages.tsx","utf8");
const sheet=readFileSync("apps/web/src/ItemCardBottomSheetHost.tsx","utf8");
const editor=page.slice(page.indexOf("function ItemEditor({"),page.indexOf("function UnitPreview({"));

test("Close leaves the current item immediately even after a stale revision",()=>{
  const close=editor.slice(editor.indexOf("  function leaveEditor() {"),editor.indexOf("  const parsedFactor2",editor.indexOf("  function leaveEditor() {")));
  assert.match(close,/closingRef\.current = true;/);
  assert.match(close,/onClose\?\.\(\)/);
  assert.match(close,/allowNavigation\.current = true;/);
  assert.doesNotMatch(close,/void save\(/);
  assert.doesNotMatch(close,/if \(item && dirty\)/);
  assert.doesNotMatch(close,/if \(item && \(optionBusy \|\| stocktakeBusy\)\)/);
  assert.match(editor,/onClick=\{leaveEditor\}/);
});

test("X, Escape and outside-click can dismiss the sheet while dirty or conflicting",()=>{
  assert.match(sheet,/const close = \(\) => setItemId\(null\);/);
  assert.match(sheet,/onClose=\{close\}/);
  assert.doesNotMatch(sheet,/if \(!busy\) setItemId/);
  const manager=page.slice(page.indexOf("function ItemsManager("),page.indexOf("export function ItemPage("));
  assert.match(manager,/onClose=\{\(\)=>setSheetItemId\(null\)\}/);
  assert.doesNotMatch(manager,/if\(!sheetBusy\)/);
});

test("closing cancels delayed blur and autosave attempts without disabling conflict validation",()=>{
  assert.match(editor,/const closingRef = useRef\(false\)/);
  assert.match(editor,/useEffect\(\(\) => \(\) => \{ closingRef\.current = true; \}, \[\]\)/);
  assert.match(editor,/if \(closingRef\.current \|\| readOnly \|\| !manage \|\| savingRequest\.current/);
  assert.match(editor,/error \|\| closingRef\.current\) return;/);
  assert.match(editor,/if \(closingRef\.current \|\| !item \|\| readOnly \|\| !manage\) return;/);
  assert.match(editor,/reason\.status === 409/);
  assert.match(editor,/setConflict\(true\)/);
  assert.match(editor,/تحميل النسخة الحالية/);
});
