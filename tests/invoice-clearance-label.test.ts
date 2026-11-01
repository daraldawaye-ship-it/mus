import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { saleClearanceRate } from "../apps/web/src/invoice-clearance-label.ts";

const item = {
  active: true,
  commissionRate: "5.0000",
  clearanceFrom: "2026-10-10",
  clearanceTo: "2026-10-19",
};

test("sales item search shows clearance percentage for both inclusive invoice date boundaries", () => {
  assert.equal(saleClearanceRate(item, "2026-10-10"), "5");
  assert.equal(saleClearanceRate(item, "2026-10-17"), "5");
  assert.equal(saleClearanceRate(item, "2026-10-19"), "5");
  assert.equal(saleClearanceRate(item, "2026-10-09"), null);
  assert.equal(saleClearanceRate(item, "2026-10-20"), null);
});

test("sales item search hides inactive, expired, invalid or incomplete clearance offers", () => {
  assert.equal(saleClearanceRate({...item,commissionRate:"0"}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,active:false}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,clearanceFrom:null}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,clearanceTo:null}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,commissionRate:"-1"}, "2026-10-17"), null);
  assert.equal(saleClearanceRate({...item,commissionRate:"NaN"}, "2026-10-17"), null);
  assert.equal(saleClearanceRate(item, ""), null);
  assert.equal(saleClearanceRate(item, "2026-10-17T00:00:00Z"), null);
  assert.equal(saleClearanceRate({...item,commissionRate:"2.5000"}, "2026-10-17"), "2.5");
});

// Sale-row clearance is not duplicated below the selected item name.
// The header presents an unused shortcut ahead of clearance, notes and peers.
test("sales header puts unused shortcut first and omits redundant row clearance", () => {
  const source = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  const alerts = readFileSync("apps/web/src/InvoiceSaleAlerts.tsx", "utf8");
  const styles = readFileSync("apps/web/src/styles.css", "utf8");
  assert.doesNotMatch(source, /commerce-sale-line-clearance-label/);
  assert.doesNotMatch(styles, /commerce-sale-line-clearance-label/);
  assert.match(source, /unusedShortcut=\{selectedHeaderLine && !selectedHeaderLine\.selectedByShortcut/);
  assert.match(source, /selectedByShortcut\?: boolean;/);
  assert.match(source, /if \(match\) choose\(match, true\)/);
  assert.match(source, /onChoose\(item, selectedByShortcut\)/);
  assert.match(source, /chooseItem\(line, selected, false, selectedByShortcut\)/);
  assert.match(alerts, /unusedShortcut\?\.trim\(\)/);
  assert.ok(alerts.indexOf('key="unused-shortcut"') < alerts.indexOf('key="current-clearance"'));
  assert.ok(alerts.indexOf('key="current-clearance"') < alerts.indexOf('data?.saleNotes'));
  assert.match(alerts, /\(\{unusedShortcut\.trim\(\)\}\)/);
  assert.match(styles, /\.invoice-sale-inline-shortcut\s*\{[^}]*background:\s*#ffb300;/);
});
