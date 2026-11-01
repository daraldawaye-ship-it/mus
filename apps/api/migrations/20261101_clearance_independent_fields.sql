-- Item-card clearance settings are independent editable fields.
-- Earlier migration 032 forced both dates before accepting a positive rate.
-- That prevents autosaving each control and is NOT an invoice eligibility rule.
-- Remove only that cross-field constraint: the commission_rate 0..100 CHECK
-- and per-column date types remain intact. All sales/earnings code continues
-- to require a positive rate and two correctly ordered dates containing the
-- invoice date; incomplete or reversed drafts accrue zero.
ALTER TABLE items DROP CONSTRAINT IF EXISTS item_clearance_period;

COMMENT ON COLUMN items.commission_rate IS
  'Stored independently; active only with both valid clearance dates covering the sale date.';
COMMENT ON COLUMN items.clearance_from IS
  'Optional independent field; no clearance accrues until positive rate and both dates are valid.';
COMMENT ON COLUMN items.clearance_to IS
  'Optional independent field; invalid or incomplete ranges must never accrue clearance.';
