import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isOperatorSearchAllowed, normalizeOperatorSearchText, operatorActivityPageKeys,
  operatorSearchActionKeys,
} from "../packages/contracts/src/operator-activity.ts";

test("operator search permits only catalog controls, never invoices or sensitive screens", () => {
  const allowed = operatorSearchActionKeys.flatMap(action =>
    operatorActivityPageKeys.filter(page => isOperatorSearchAllowed(action,page))
      .map(page => `${action}:${page}`));
  assert.deepEqual(allowed, [
    "items.search:company.overview", "items.search:company.items",
    "market.search:public.medicine_market", "lists.search:company.inventory",
  ]);
});

test("catalog search requires three letters and never retains identifiers or credentials", () => {
  assert.equal(normalizeOperatorSearchText("  أموكسيل  شراب  "), "أموكسيل شراب");
  assert.equal(normalizeOperatorSearchText("Cefazolin-sodium"), "Cefazolin-sodium");
  for (const rejected of ["أب", "123456789", "دواء 777123456", "name@test.com",
    "abc\ndef", "Abc?def", "secret key", "رمز التحقق", "أ".repeat(65)])
    assert.equal(normalizeOperatorSearchText(rejected), null, rejected);
});

test("server gates tagged events by real authenticated actor and current company membership", async () => {
  const route = await readFile(new URL("../apps/api/src/routes-interest-events.ts", import.meta.url),"utf8");
  assert.match(route,/actorId === null \|\| item\.actorId !== actorId/);
  assert.match(route,/e\.company_id=c\.id AND e\.user_id=u\.id AND e\.active/);
  assert.match(route,/WHERE c\.id=\$1 AND \(u\.owner OR e\.id IS NOT NULL\)/);
  assert.match(route,/ownerOnly\(user\)/);
  assert.match(route,/saved \+= inserted\.rowCount \?\? 0;\s*continue;/);
  assert.match(route,/WHERE occurred_at < now\(\) - interval '100 days'/);
  assert.doesNotMatch(route,/DELETE FROM (?!interest_events)/);
});
