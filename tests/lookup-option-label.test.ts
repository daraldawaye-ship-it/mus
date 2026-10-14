import assert from "node:assert/strict";
import test from "node:test";
import { lookupOptionLabel } from "../apps/web/src/lookup-option-label.ts";

test("account picker labels fit narrow viewport without changing account identities", () => {
  const full = "2110000123 — شركة الأدوية والمستلزمات الطبية واسم الفرع الطويل جدًا للتجربة";
  assert.equal(lookupOptionLabel("2110000123 — مورد", 320), "2110000123 — مورد");
  assert(lookupOptionLabel(full, 320).endsWith("…"));
  assert.equal(Array.from(lookupOptionLabel(full, 320)).length, 18);
  assert.equal(Array.from(lookupOptionLabel(full, 600)).length, 26);
  assert.equal(Array.from(lookupOptionLabel(full, 1440)).length, 40);
  assert(lookupOptionLabel(full, 320).startsWith("2110000123"));
  assert.equal(lookupOptionLabel(full, 1440), lookupOptionLabel(full, 1440));
  assert.equal(lookupOptionLabel("مورد", 320), "مورد");
});
