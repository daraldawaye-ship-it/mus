import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanyContext, PageEntry } from "../packages/contracts/src/index.ts";
import { workPanelItemActionAccess } from "../apps/web/src/work-panel-item-action-access.ts";

const page = (key:string, actions: ("view"|"edit"|"create")[], enabled=true) => ({
  key,enabled,actionAccess:Object.fromEntries(actions.map(action=>[action,true])),
}) as PageEntry;
const directory=[
  page("company.public-requests",["create"]),
  page("company.items",["view","edit"]),
  page("company.item-card",["view","edit"]),
  page("company.stock-adjustments",["view","create"]),
  page("company.stock-operations",["view"]),
  page("company.memos",["view","create"]),
];
const context = (permissions:CompanyContext["permissions"]=[],general=false) =>
  ({permissions,general}) as CompanyContext;
const none={"public-request":false,edit:false,adjust:false,transfer:false,report:false};

test("workboard actions fail closed with no company or no permission directory", () => {
  assert.deepEqual(workPanelItemActionAccess(undefined,directory),none);
  assert.deepEqual(workPanelItemActionAccess(context([],true),undefined),none);
});
test("workboard preserves invoice menu access checks per action and page", () => {
  assert.deepEqual(workPanelItemActionAccess(context(["items.manage","inventory.post","finance.post"]),directory),
    {"public-request":true,edit:true,adjust:true,transfer:true,report:true});
  assert.deepEqual(workPanelItemActionAccess(context(["inventory.post"]),directory),
    {"public-request":true,edit:false,adjust:false,transfer:true,report:true});
  const disabled=directory.filter(entry=>entry.key!=="company.item-card"&&entry.key!=="company.memos")
    .concat(page("company.memos",["view","create"],false));
  assert.deepEqual(workPanelItemActionAccess(context([],true),disabled),
    {"public-request":true,edit:false,adjust:true,transfer:true,report:false});
});
