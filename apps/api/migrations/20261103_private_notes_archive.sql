-- Existing private notes remain untouched; archiving only sets a timestamp.
ALTER TABLE user_private_notes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS user_private_notes_owner_archive_date
  ON user_private_notes(user_id,archived_at,created_at DESC,id DESC);
