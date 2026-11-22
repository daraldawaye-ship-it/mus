import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("keep scoped D13 mounted with no stale rows or interactive controls when query changes", async()=>{
 const p=await readFile(new URL("../apps/web/src/pages/ItemOptionsListPage.tsx",import.meta.url),"utf8");
 assert.match(p, /!result\.rows\.length[\s\S]*?<\/>\}\s*\{\/\* Keep the visit layout[\s\S]*?<div hidden=\{!result\}>\s*<InteractiveColumnsTable<Row, TableColumn>/);
 assert.match(p, /key=\{columnLayoutStorageKey\}[\s\S]{0,360}rows=\{result\?\.rows \?\? \[\]\}[\s\S]{0,240}persistLayout=\{false\}/);
 assert.match(p, /<\/div>\s*\{result && <div className="form-actions">/);
});
