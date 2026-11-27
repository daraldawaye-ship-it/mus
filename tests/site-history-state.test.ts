import assert from "node:assert/strict";
import test from "node:test";
import {siteHistory} from "../apps/web/src/site-history-state.ts";

test("site navigation follows browser entries and clears forward history on a new visit", () => {
  const start = siteHistory(null,{index:0,key:"market"},"POP");
  assert.equal(start.furthest,0);
  const card = siteHistory(start,{index:1,key:"card"},"PUSH");
  const otherPage = siteHistory(card,{index:2,key:"company"},"PUSH");
  const previous = siteHistory(otherPage,{index:1,key:"card"},"POP");
  assert.equal(previous.furthest,2);
  assert.equal(siteHistory(previous,{index:2,key:"company"},"POP").furthest,2);
  const replace = siteHistory(previous,{index:1,key:"card-filter"},"REPLACE");
  assert.equal(replace.furthest,2);
  const next = siteHistory(replace,{index:2,key:"admin"},"PUSH");
  const home = siteHistory(next,{index:0,key:"market"},"POP");
  assert.equal(home.furthest,2);
  assert.equal(siteHistory(home,{index:1,key:"different"},"PUSH").furthest,1);
});
