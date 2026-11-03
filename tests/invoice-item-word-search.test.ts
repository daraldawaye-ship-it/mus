import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { matchesOrderedItemWords } from "../packages/contracts/src/invoice-item-search.ts";
import { searchPattern } from "../apps/api/src/services/lists.ts";

test("searching separated words finds a product with omitted middle words", () => {
  const name = "فادين كول اقراص مصوص";
  assert.equal(matchesOrderedItemWords(name, ["فادين", "مصوص"]), true);
  assert.equal(matchesOrderedItemWords(name, ["فادين", "كول"]), true);
  assert.equal(matchesOrderedItemWords(name, ["فادين", "شراب"]), false);
  assert.equal(matchesOrderedItemWords(name, ["مصوص", "فادين"]), false);
  assert.equal(matchesOrderedItemWords(name, ["فادين كول"]), true);
});

test("SQL item word gaps preserve literal wildcard escaping", () => {
  assert.equal(searchPattern("فادين مصوص"), "%فادين مصوص%");
  assert.equal(searchPattern("فادين مصوص", true), "%فادين%مصوص%");
  assert.equal(searchPattern("  فادين   مصوص  ", true), "%فادين%مصوص%");
  assert.equal(searchPattern("فادين _ مصوص", true), "%فادين%\\_%مصوص%");
  assert.equal(searchPattern("فادين% مصوص", true), "%فادين\\%%مصوص%");
});

test("invoice, item catalog and filtered item list share ordered word matching", () => {
  const local = readFileSync("apps/web/src/offline-shared-items.ts", "utf8");
  const masters = readFileSync("apps/api/src/services/masters.ts", "utf8");
  const itemList = readFileSync("apps/api/src/routes-item-options-list.ts", "utf8");
  assert.match(local, /matchesOrderedItemWords\(item\.text,words\)/);
  assert.match(local, /matchesOrderedItemWords\(normalized\(x\[k\]\),words\)/);
  assert.match(masters, /searchPattern\(query\.q, optionKind === "item" \|\| !!searchPlan\)/);
  assert.match(itemList, /searchPattern\(options\.q, true\)/);
  assert.doesNotMatch(itemList, /ILIKE '%'\|\|\$3\|\|'%'/);
});
