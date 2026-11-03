import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => readFileSync(file, "utf8");

test("manual and saved filters clear the entire company selection before applying", () => {
  const page = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const hook = read("apps/web/src/shared-item-selection.ts");
  const server = read("apps/api/src/routes-item-temporary-selection.ts");

  const runner = page.slice(page.indexOf("async function runFilterApplication("), page.indexOf("function apply(event:"));
  const manual = page.slice(page.indexOf("function apply(event:"), page.indexOf("// Save draft controls"));
  const saved = page.slice(page.indexOf("function applyPreset("), page.indexOf("async function deletePreset("));

  assert.match(runner, /if \(temporarySelection\.updating\)/);
  assert.match(runner, /canEditReserve && !\(await temporarySelection\.clear\(\)\)/);
  assert.ok(runner.indexOf("await temporarySelection.clear()") < runner.indexOf("applyFilters();"),
    "company-wide clearing must finish before changing the visible filter");
  assert.match(runner, /لم يُطبَّق الفلتر/);
  assert.match(runner, /applyingFilterRef\.current = true/);
  assert.match(runner, /applyingFilterRef\.current = false/);
  assert.match(manual, /if \(invalid\) \{/);
  assert.ok(manual.indexOf("if (invalid)") < manual.indexOf("runFilterApplication("),
    "invalid filter values must not clear the user's current selection");
  assert.match(manual, /runFilterApplication\(\(\) => setParams\(/);
  assert.match(saved, /if \(!filters\.success\) \{/);
  assert.ok(saved.indexOf("if (!filters.success)") < saved.indexOf("runFilterApplication("));
  assert.match(saved, /runFilterApplication\(\(\) => \{/);

  assert.match(hook, /method: "DELETE", body: \{ confirm: true \}/);
  assert.match(hook, /await client\.invalidateQueries\(\{ queryKey: key, exact: true \}\)/);
  assert.match(server, /DELETE FROM company_item_temporary_selections WHERE company_id=\$1/);
  assert.match(server, /assertDirectoryAccess\(listPage, "edit"\)/);
  assert.ok(page.includes("دون حذف مسودات الطلبيات"));
});

test("automatic clearing only runs on apply actions, not saved-filter creation, paging, or sorting", () => {
  const source = read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const sections = [
    source.slice(source.indexOf("async function savePreset()"), source.indexOf("function applyPreset(")),
    source.slice(source.indexOf("function reset()"), source.indexOf("function rememberItem(")),
    source.slice(source.indexOf("function sortByColumn("), source.indexOf("return <div className=")),
  ];
  for (const section of sections) {
    assert.doesNotMatch(section, /temporarySelection\.clear\(/);
    assert.doesNotMatch(section, /runFilterApplication\(/);
  }
  assert.match(source, /disabled=\{!canView \|\| applyingFilter \|\| temporarySelection\.updating\}/);
  assert.match(source, /disabled=\{!selectedPreset \|\| applyingFilter \|\| temporarySelection\.updating\}/);
  assert.match(source, /window\.confirm\(`سيتم تصفير جميع الاختيارات المؤقتة/,
    "manual clear retains its explicit confirmation");
});
