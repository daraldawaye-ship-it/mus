-- Keep legacy DATE fields for reports and date-only history, and add genuine
-- independent timestamp fields for the moment an item was displayed/approved.
-- Do not invent an hour for previously entered date-only values.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS settlement_display_at timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_approval_at timestamptz;

-- The 2026-11-08 Dar Al Dawa bulk action captured its actual execution time
-- per item in the preceding migration's snapshot table. Restore only those
-- timestamps for records which still match that specific bulk action's dates.
-- This records when the administrative bulk action happened, NOT a physical count.
UPDATE items AS i SET
  settlement_display_at = prior.snapshot_at,
  settlement_approval_at = prior.snapshot_at,
  revision = i.revision + 1,
  updated_at = clock_timestamp()
FROM daraldawa_settlement_dates_before_20261108 AS prior
WHERE i.company_id = 2
  AND prior.item_id = i.id
  AND i.settlement_display_date = DATE '2026-11-08'
  AND i.settlement_approval_date = DATE '2026-11-08'
  AND i.settlement_display_at IS NULL
  AND i.settlement_approval_at IS NULL;
