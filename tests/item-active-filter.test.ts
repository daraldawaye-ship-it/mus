import assert from "node:assert/strict";
import test from "node:test";
import { itemActiveFilter, itemActiveQueryValue } from "../apps/web/src/item-active-filter.ts";

test("items listing defaults to active only when no status URL filter is set", () => {
  assert.equal(itemActiveFilter(null), "true");
  assert.equal(itemActiveFilter(""), "true");
  assert.equal(itemActiveFilter("unknown"), "true");
  assert.equal(itemActiveQueryValue(itemActiveFilter(null)), "true");
});

test("explicit archived and all statuses persist correctly in the items list", () => {
  assert.equal(itemActiveFilter("false"), "false");
  assert.equal(itemActiveQueryValue(itemActiveFilter("false")), "false");
  assert.equal(itemActiveFilter("all"), "all");
  assert.equal(itemActiveQueryValue(itemActiveFilter("all")), null);
  assert.equal(itemActiveFilter("true"), "true");
  assert.equal(itemActiveQueryValue(itemActiveFilter("true")), "true");
});
