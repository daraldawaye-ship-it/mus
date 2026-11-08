-- Applied separately because visitor-fast-entry migration was already executed
-- before the session scope column was introduced.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visitor_only boolean NOT NULL DEFAULT false;
