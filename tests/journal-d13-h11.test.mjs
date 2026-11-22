import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { transform } from "esbuild";
test("journals only use canonical date and table while retaining server paging and sorting", async () => {
  const get = path => readFile(new URL(`../apps/web/src/${path}`, import.meta.url), "utf8");
  const source = await get("pages/FinancePages.tsx");
  const list = source.split("function DocumentList")[1].split("export function FinanceDocumentPage")[0];
  assert.match(list, /kind === "journal" \? <>\s*<DateField[\s\S]*?onCommit=\{value => updateFilter\(setParams, "dateFrom", value\)\}/);
  assert.match(list, /kind === "journal" \? <>\s*<InteractiveColumnsTable[\s\S]+?list.setSorting[\s\S]+?list.setPageSize[\s\S]+?list.setPage/);
  assert.match(list, /<\/\> : <DataTable/);
  assert.match(source, /kind === "journal" \? \(\s*<DateField label="تاريخ المستند"[\s\S]+?allowDateEdit/);
  assert.match(source, /kind === "journal" \? <DateField label="تاريخ القيد العكسي"[\s\S]+?onCommit=\{setReverseDate\}/);
  const shared = await get("ui.tsx");
  const date = shared.split("export function DateField")[1].split("export function Select")[0];
  assert.match(date, /required=\{required\}[\s\S]*disabled=\{disabled\}/);
  assert.match(date, /input.validity.valid/);
  for (const data of [source, shared]) await transform(data, {loader:"tsx"});
});
