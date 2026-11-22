import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transform } from "esbuild";
const read = rel => readFile(new URL(`../${rel}`, import.meta.url), "utf8");

test("the items table ignores a stored D13 layout on entry, other pages retain it", async () => {
  const [table, page] = await Promise.all([
    read("apps/web/src/InteractiveColumnsTable.tsx"),
    read("apps/web/src/pages/ItemOptionsListPage.tsx"),
  ]);
  const definitions = table.slice(table.indexOf("const MIN_WIDTH"), table.indexOf("/** A scope change"));
  const initial = table.match(/const \[layout, setLayout\] = useState\(\(\) => (.*)\);/)[1];
  const fake = `const usableColumnDefaults=(keys,shared)=>shared.filter(row=>keys.includes(row.id));
    let hits=0;
    const window={localStorage:{getItem:()=>{hits++;return JSON.stringify({order:["a","b"],widths:{a:600,b:500}})}}};
    ${definitions}
    export const getHits=()=>hits;
    export const initial=(columns,sharedDefaults,persistLayout,storageKey="test")=>${initial};`;
  const { code } = await transform(fake, {loader:"ts",format:"esm"});
  const {initial: init,getHits} = await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
  const columns=[{key:"a",width:150},{key:"b",width:80}];
  const defaults=[{id:"b",width:120},{id:"a",width:200}];
  assert.deepEqual(init(columns,defaults,false),{order:["b","a"],widths:{a:200,b:120}});
  assert.deepEqual(init(columns,[],false),{order:["a","b"],widths:{a:150,b:80}});
  assert.equal(getHits(),0);
  assert.deepEqual(init(columns,defaults,true),{order:["a","b"],widths:{a:600,b:500}});
  assert.equal(getHits(),1);
  assert.match(table,/if \(drag.current \|\| resize.current \|\| localOverride.current\) return;/);
  assert.match(table,/localOverride.current = next;\s+if \(!persistLayout\) return;\s+try \{ window.localStorage.setItem/);
  assert.match(table,/if \(!persistLayout\) \{\s+localOverride.current = null;\s+\} else if/);
  assert.match(page,/storageKey=\{columnLayoutStorageKey\} sharedDefaults=\{savedDefaults\} persistLayout=\{false\}/);
  assert.match(page,/setVisibleColumns\(restoredColumns\)/);
});
