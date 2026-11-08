-- Owner's 8 Nov 2026 instruction: Set BOTH item-card settlement timestamps
-- for Dar Al Dawa (company_id=2) to exactly 48 hours before this migration runs.
-- This is an administrative backdating, not proof of physical counting/approval.
-- Do NOT change stocktake_required_at, posted adjustments, balances or journals.
-- Preserve all previous timestamps and date-only compatibility fields for review.
CREATE TABLE IF NOT EXISTS daraldawa_settlement_forty_eight_hours_backup_20261108 (
  item_id integer PRIMARY KEY,
  previous_display_at timestamptz,
  previous_approval_at timestamptz,
  previous_display_date date,
  previous_approval_date date,
  applied_at timestamptz NOT NULL,
  target_at timestamptz NOT NULL
);

-- A single clock reading makes both fields identical on every company 2 item,
-- including the same seconds/microseconds. Save old values BEFORE changing them.
WITH anchor AS MATERIALIZED (
  SELECT clock_timestamp() AS applied_at
), preserved AS (
  INSERT INTO daraldawa_settlement_forty_eight_hours_backup_20261108
    (item_id, previous_display_at, previous_approval_at,
     previous_display_date, previous_approval_date, applied_at, target_at)
  SELECT i.id, i.settlement_display_at, i.settlement_approval_at,
         i.settlement_display_date, i.settlement_approval_date,
         a.applied_at, a.applied_at - INTERVAL '48 hours'
  FROM items i CROSS JOIN anchor a
  WHERE i.company_id = 2
  ON CONFLICT (item_id) DO NOTHING
  RETURNING item_id, applied_at, target_at
)
UPDATE items i SET
  settlement_display_at = p.target_at,
  settlement_approval_at = p.target_at,
  settlement_display_date = (p.target_at AT TIME ZONE 'Asia/Aden')::date,
  settlement_approval_date = (p.target_at AT TIME ZONE 'Asia/Aden')::date,
  revision = i.revision + 1,
  updated_at = p.applied_at
FROM preserved p
WHERE i.company_id = 2 AND i.id = p.item_id;
