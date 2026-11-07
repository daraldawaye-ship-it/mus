-- One-time, owner-initiated title casing for imported market medicine names.
-- The source staging table remains unchanged and each run is idempotent.
CREATE TABLE market_card_name_format_runs (
 id uuid PRIMARY KEY,
 source_id bigint NOT NULL REFERENCES market_import_sources(id),
 operation text NOT NULL CHECK (operation='title_case'),
 actor_id integer NOT NULL REFERENCES users(id),
 status text NOT NULL CHECK (status IN ('running','complete','failed')),
 total integer NOT NULL DEFAULT 0,
 changed integer NOT NULL DEFAULT 0,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_id,operation)
);
