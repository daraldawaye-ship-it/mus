-- Interest analytics are separate from security/financial audit_events.
-- The rollup and first-event snapshots survive the 100-day raw-event retention.
CREATE TABLE IF NOT EXISTS interest_events (
  id BIGSERIAL PRIMARY KEY,
  event_uuid UUID NOT NULL UNIQUE,
  subject_key TEXT NOT NULL,
  actor_id INTEGER,
  visitor_id UUID,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'page',
  target_id INTEGER NOT NULL DEFAULT 0,
  dimension_text TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  pathname TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interest_events_date_idx ON interest_events(occurred_at, id);
CREATE INDEX IF NOT EXISTS interest_events_subject_date_idx ON interest_events(subject_key,occurred_at DESC);
CREATE INDEX IF NOT EXISTS interest_events_action_date_idx ON interest_events(action,occurred_at DESC);

CREATE TABLE IF NOT EXISTS interest_totals (
  subject_key TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL DEFAULT 0,
  dimension_text TEXT NOT NULL DEFAULT '',
  pathname TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  total BIGINT NOT NULL DEFAULT 0,
  first_at TIMESTAMPTZ NOT NULL,
  last_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(subject_key,action,target_type,target_id,dimension_text,pathname)
);
CREATE INDEX IF NOT EXISTS interest_totals_action_idx ON interest_totals(action,total DESC);
CREATE INDEX IF NOT EXISTS interest_totals_subject_idx ON interest_totals(subject_key,action);

CREATE TABLE IF NOT EXISTS interest_first_events (
  subject_key TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  pathname TEXT NOT NULL,
  event_uuid UUID NOT NULL,
  actor_id INTEGER,
  visitor_id UUID,
  dimension_text TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(subject_key,action,target_type,target_id,pathname)
);
