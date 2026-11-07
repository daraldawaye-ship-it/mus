-- One-time owner-authorized promotion of a verified staging source into market medicine cards.
-- Runs are durable and idempotent; the source and its original rows are never modified.
CREATE TABLE market_card_import_runs (
  id uuid PRIMARY KEY,
  source_id bigint NOT NULL UNIQUE REFERENCES market_import_sources(id),
  actor_id integer NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('running','complete','failed')),
  source_rows integer NOT NULL DEFAULT 0,
  inserted integer NOT NULL DEFAULT 0,
  duplicates integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  arabic_names integer NOT NULL DEFAULT 0,
  archived_existing integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
