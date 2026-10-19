-- Allow a separate company/branch inventory location for customer returns.
-- Existing showroom and warehouse rows, codes, IDs and stock references are preserved.
-- The one-showroom-per-branch unique index remains unchanged.
ALTER TABLE locations
  DROP CONSTRAINT IF EXISTS locations_kind_check;
ALTER TABLE locations
  ADD CONSTRAINT locations_kind_check
    CHECK (kind IN ('showroom', 'warehouse', 'returns'));
