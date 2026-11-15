-- NULL inherits the code default, retaining existing chat behavior without backfill.
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS complete_on_click boolean;
