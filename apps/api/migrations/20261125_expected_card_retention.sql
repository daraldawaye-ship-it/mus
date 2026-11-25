ALTER TABLE expected_cards
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archive_day date,
  ADD COLUMN lifecycle_revision integer NOT NULL DEFAULT 1 CHECK (lifecycle_revision > 0),
  ADD COLUMN purged_movement_count integer NOT NULL DEFAULT 0 CHECK (purged_movement_count >= 0),
  ADD CONSTRAINT expected_cards_archive_pair CHECK ((archived_at IS NULL) = (archive_day IS NULL));

ALTER TABLE expected_movements
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT expected_movements_archive_pending CHECK (archived_at IS NULL OR status='pending');

CREATE INDEX expected_movements_retention ON expected_movements(archived_at,company_id,card_id)
  WHERE archived_at IS NOT NULL AND status='pending';
