import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base=readFileSync("apps/web/src/styles.css","utf8");
const tabbed=readFileSync("apps/web/src/user-menu-tabs.css","utf8");
const menu=readFileSync("apps/web/src/UserMenu.tsx","utf8");

/** Extract all exact selector declarations so a later CSS block cannot
 * accidentally replace the popup positioning with an in-flow value. */
function declarationList(css:string,selector:string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match=>match[1]!.split(",").some(part=>part.trim()===selector))
    .map(match=>match[2]!);
}
test("avatar popup stays absolutely positioned under the trigger",()=>{
  const bases=declarationList(base,".user-menu-panel");
  const tabs=declarationList(tabbed,".user-menu-panel.user-menu-tabbed-panel");
  assert.ok(bases.some(body=>/position:\s*absolute\s*;/.test(body)),"base popup position:absolute");
  assert.ok(bases.some(body=>/top:\s*calc\(100%\s*\+\s*6px\)/.test(body)),"popup appears below avatar");
  assert.ok(tabs.length>0,"tabbed panel may set dimensions");
  assert.ok(tabs.every(body=>!/\bposition\s*:/i.test(body)),"do not override absolute with relative");
  assert.ok(tabs.some(body=>/max-height:\s*min\(360px,\s*calc\(100dvh - 66px\)\)/.test(body)),
    "popup height constrained to viewport");
});
test("quick add menu is positioned within the popup without changing footer height",()=>{
  assert.ok(declarationList(tabbed,".user-menu-quick-options")
    .some(body=>/position:\s*absolute/.test(body)&&/bottom:\s*46px/.test(body)),
    "quick options float above existing footer");
  assert.ok(declarationList(tabbed,".user-menu-tabs-footer.user-menu-settings-actions")
    .some(body=>/height:\s*38px/.test(body)), "compact footer unchanged");
  assert.match(menu,/className="user-menu-panel user-menu-tabbed-panel"/);
  assert.match(menu,/className="user-menu-tabs"/);
  assert.match(menu,/className="user-menu-quick-options"/);
});
