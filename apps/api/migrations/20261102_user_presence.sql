-- Minimal, per-user presence checkpoint. Records recent authenticated use,
-- not attendance, payroll, browsing content, or a full session audit.
-- One row per user; updated at most once per minute by a foreground client.
CREATE TABLE IF NOT EXISTS user_presence (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS user_presence_recent_idx ON user_presence(last_seen_at DESC, user_id);
