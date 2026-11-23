import { test } from "node:test";
import { strict as assert } from "node:assert";
import { canSubmitStaffWorkPanelPublicRequest as maySubmit } from "../packages/contracts/src/work-panel-public-requests.ts";

test("Dar Aldawa's work-panel shortcut permits both active item-dock positions", () => {
  const staff = { owner:false, suspended:false, archived:false };
  assert.equal(maySubmit(2,staff,{active:true,positions:["sales"]}),true);
  assert.equal(maySubmit(2,staff,{active:true,positions:["cashier"]}),true);
});

test("work-panel shortcut excludes other companies, positions, inactive employees and disabled accounts", () => {
  const staff = { owner:false, suspended:false, archived:false };
  const sales = { active:true, positions:["sales"] };
  assert.equal(maySubmit(1,staff,sales),false);
  assert.equal(maySubmit(null,staff,sales),false);
  assert.equal(maySubmit(2,staff,null),false);
  assert.equal(maySubmit(2,staff,{active:false,positions:["sales"]}),false);
  assert.equal(maySubmit(2,staff,{active:true,positions:["purchasing"]}),false);
  assert.equal(maySubmit(2,{...staff,suspended:true},sales),false);
  assert.equal(maySubmit(2,{...staff,archived:true},sales),false);
  assert.equal(maySubmit(2,{...staff,owner:true},sales),false);
});
