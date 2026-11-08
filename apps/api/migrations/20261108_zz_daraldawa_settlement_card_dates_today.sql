-- One-time owner-directed normalization for Dar Al Dawa (company_id=2).
-- These are item-card planning dates only; never edit posted stock operations,
-- physical counts, financial documents, or historical invoice dates.
-- Capture the exact previous values so this bulk change remains reversible.
CREATE TABLE IF NOT EXISTS daraldawa_settlement_dates_before_20261108 (
  item_id integer PRIMARY KEY,
  previous_display_date date,
  previous_approval_date date,
  snapshot_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Use the pharmacy's Asia/Aden date, fixed once for this transaction.
WITH date_today AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date AS value
)
INSERT INTO daraldawa_settlement_dates_before_20261108
  (item_id, previous_display_date, previous_approval_date)
SELECT i.id, i.settlement_display_date, i.settlement_approval_date
FROM items i CROSS JOIN date_today d
WHERE i.company_id=2 AND (
  i.settlement_display_date IS DISTINCT FROM d.value OR
  i.settlement_approval_date IS DISTINCT FROM d.value
)
ON CONFLICT (item_id) DO NOTHING;

WITH date_today AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date AS value
)
UPDATE items i SET
  settlement_display_date = d.value,
  settlement_approval_date = d.value,
  revision = i.revision + 1,
  updated_at = clock_timestamp()
FROM date_today d
WHERE i.company_id=2 AND (
  i.settlement_display_date IS DISTINCT FROM d.value OR
  i.settlement_approval_date IS DISTINCT FROM d.value
);
