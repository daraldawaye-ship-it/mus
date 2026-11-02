import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read=(path:string)=>readFileSync(path,"utf8");

test("options panel renders two-and-a-half field rows in an internal scroll region",()=>{
  const source=read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const css=read("apps/web/src/styles.css");
  assert.ok(source.includes('className="item-options-filters-card"'));
  assert.ok(source.includes('className="item-options-filter-scroll" role="region"'));
  assert.ok(source.includes('className="item-options-filter-grid"'));
  assert.ok(css.includes(".item-options-filters-card .item-options-filter-scroll"));
  assert.ok(css.includes("--item-filter-row-height: 52px"));
  assert.ok(css.includes("height: calc(var(--item-filter-row-height) * 2.5"));
  assert.ok(css.includes("overflow-y: auto"));
  assert.ok(css.includes("overscroll-behavior: contain"));
  assert.ok(css.includes("scrollbar-gutter: stable"));
  assert.ok(css.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"));
  assert.ok(css.includes("grid-template-columns: minmax(0, 1fr)"),"narrow phones use a single column");
});

test("labels stay inside fields and visible even when default values exist",()=>{
  const source=read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const css=read("apps/web/src/styles.css");
  const section=source.slice(source.indexOf('!optionsCollapsed && <Card'),source.indexOf('{filterError && <Notice'));
  assert.ok(section.includes('<label className="item-options-filter-field">'));
  assert.ok(section.includes('<span className="item-options-filter-label">بحث عن صنف'));
  assert.ok(section.includes('<span className="item-options-filter-label">حالة الصنف</span>'));
  assert.ok(section.includes('<span className="item-options-filter-label" title={label}>{label}</span>'));
  assert.ok(section.includes('type="number" step="any"'));
  assert.ok(!section.includes('placeholder="بدون حد"'),"empty numeric range has no filler text");
  assert.ok(section.includes("value={draft[key]}"),"retain previously set ranges");
  assert.ok(section.includes("value={search}"),"search remains controlled");
  assert.ok(section.includes("value={active}"),"status remains controlled");
  assert.ok(css.includes(".item-options-filter-field .item-options-filter-label"));
  assert.ok(css.includes("position: absolute"));
  assert.ok(css.includes("pointer-events: none"),"label does not block editing");
  assert.ok(css.includes("padding-block: 22px 5px"),"content sits beneath embedded title");
  assert.ok(css.includes(".item-options-filters-card .item-options-filter-field > input"),
    "item options padding wins over global input:not selectors");
  assert.ok(css.includes("height: var(--item-filter-row-height)"),"field uses complete row height");
});

test("controls and selected options remain outside scroll viewport",()=>{
  const source=read("apps/web/src/pages/ItemOptionsListPage.tsx");
  const begin=source.indexOf('!optionsCollapsed && <Card');
  const end=source.indexOf('{filterError && <Notice',begin);
  const content=source.slice(begin,end);
  const scrollOpen=content.indexOf('className="item-options-filter-scroll"');
  const scrollClose=content.indexOf('className="form-actions item-options-filter-actions"');
  assert.ok(scrollOpen>-1&&scrollClose>scrollOpen);
  assert.ok(content.slice(scrollOpen,scrollClose).includes('{ranges.map('));
  assert.ok(content.slice(scrollClose).includes("draft.excludeZero"));
  assert.ok(content.slice(scrollClose).includes("draft.useReserve"));
  assert.ok(content.slice(scrollClose).includes("تطبيق الخيارات"));
  assert.ok(content.slice(scrollClose).includes("إعادة الافتراضيات"));
  assert.ok(read("apps/web/src/styles.css").includes(".item-options-filters-card .item-options-filter-actions"));
});

test("filter validation, numerical defaults, reset and URL handling stay unchanged",()=>{
  const source=read("apps/web/src/pages/ItemOptionsListPage.tsx");
  assert.ok(source.includes('stockMin: params.get("stockMin") ?? "1"'));
  assert.ok(source.includes('stockMax: params.get("stockMax") ?? "1"'));
  assert.ok(source.includes('const numberPattern = /^-?'));
  assert.ok(source.includes('draft[key].trim() && !numberPattern.test'));
  assert.ok(source.includes('next.set(key, value)'));
  assert.ok(source.includes('stockMin: "1", stockMax: "1"'));
  assert.ok(source.includes('if (params.get("useReserve") === "false"') ||
    source.includes('params.get("useReserve") === "false"'));
  assert.ok(source.includes('const resultQuery = useQuery'));
});
