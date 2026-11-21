import test from "node:test";
import assert from "node:assert/strict";
import type { CompanyContext, User } from "../packages/contracts/src/index.ts";
import { showWorkPanelPrivateNotes } from "../apps/web/src/dock-private-notes-access.ts";

const user = { owner: false, suspended: false, archived: false } as User;
const context = (positions: string[], active = true) => ({ employee: { active, positions } }) as CompanyContext;
test("owner, sales and cashier can use the independent private-notes container", () => {
  assert.equal(showWorkPanelPrivateNotes({ ...user, owner: true }, undefined, false), true);
  for (const role of ["sales", "cashier"]) {
    assert.equal(showWorkPanelPrivateNotes(user, context([role]), false), true);
  }
});
test("unauthenticated, inactive, suspended, archived, other roles and employee preview are denied", () => {
  assert.equal(showWorkPanelPrivateNotes(null, context(["sales"]), false), false);
  assert.equal(showWorkPanelPrivateNotes(user, undefined, false), false);
  assert.equal(showWorkPanelPrivateNotes(user, context(["sales"], false), false), false);
  assert.equal(showWorkPanelPrivateNotes(user, context(["purchase-entry"]), false), false);
  assert.equal(showWorkPanelPrivateNotes({ ...user, suspended: true }, context(["sales"]), false), false);
  assert.equal(showWorkPanelPrivateNotes({ ...user, archived: true }, context(["cashier"]), false), false);
  assert.equal(showWorkPanelPrivateNotes({ ...user, owner: true }, context(["sales"]), true), false);
});
