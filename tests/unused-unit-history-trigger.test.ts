import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { addsOnlyPreviouslyInactiveUnits } from "../apps/api/src/services/item-unit-history.ts";

const migration=readFileSync("apps/api/migrations/20261102_allow_unused_units_at_zero.sql","utf8");
const routes=readFileSync("apps/api/src/routes-items.ts","utf8");

test("old blanket DB rejection replaced with batch-level zero guard",()=>{
  assert.match(migration,/CREATE OR REPLACE FUNCTION protect_item_stock_units\(\)/);
  assert.match(migration,/IF NOT EXISTS \(\s*SELECT 1 FROM stock_movements/);
  assert.match(migration,/OLD\.factor2 > 1/);
  assert.match(migration,/OLD\.factor3 > 1/);
  assert.match(migration,/OLD\.has_expiry IS DISTINCT FROM NEW\.has_expiry/);
  assert.match(migration,/OLD\.unit1_name IS DISTINCT FROM NEW\.unit1_name/);
  assert.match(migration,/NEW\.factor3 > 1 AND NEW\.factor2 <= 1/);
  assert.match(migration,/FROM stock_balances/);
  assert.match(migration,/quantity_smallest<>0/);
  assert.doesNotMatch(migration,/DROP TRIGGER|DISABLE TRIGGER|DELETE FROM stock_movements|UPDATE stock_balances/i);
  assert.match(routes,/addsOnlyPreviouslyInactiveUnits\(before, input\)/);
  assert.match(routes,/FROM stock_balances[\s\S]*quantity_smallest<>0/);
});

test("new unit activation allowed only when no previously used unit changes",()=>{
  const initial={unit1Name:"باكت",unit2Name:"",unit3Name:"",factor2:1,factor3:1,hasExpiry:true};
  const active={...initial,unit2Name:"أمبولة",factor2:5};
  assert.equal(addsOnlyPreviouslyInactiveUnits(initial,active),true);
  assert.equal(addsOnlyPreviouslyInactiveUnits(active,{...active,unit3Name:"حبة",factor3:10}),true);
  assert.equal(addsOnlyPreviouslyInactiveUnits(active,{...active,factor2:6}),false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(active,{...active,unit2Name:"فيال"}),false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(active,{...active,unit1Name:"علبة"}),false);
  assert.equal(addsOnlyPreviouslyInactiveUnits(active,{...active,hasExpiry:false}),false);
});
