-- Owner's AI market follow-up progress, isolated from immutable imported sources.
-- No follow-up row means this source record has not been processed.
CREATE TABLE IF NOT EXISTS market_import_row_followups (
  source_id bigint NOT NULL,
  section text NOT NULL,
  position integer NOT NULL,
  status text NOT NULL CHECK (status IN ('partial','complete')),
  completed_fields text[] NOT NULL DEFAULT '{}',
  remaining_fields text[] NOT NULL DEFAULT '{}',
  card_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(card_refs)='array'),
  notes text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by integer NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id,section,position),
  FOREIGN KEY (source_id,section,position)
    REFERENCES market_import_rows (source_id,section,position) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS market_import_row_followups_status
  ON market_import_row_followups (source_id,section,status,position);
CREATE TABLE IF NOT EXISTS market_import_row_followup_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL,
  section text NOT NULL,
  position integer NOT NULL,
  revision integer NOT NULL,
  old_value jsonb,
  new_value jsonb NOT NULL,
  actor_id integer NOT NULL REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_id,section,position)
    REFERENCES market_import_row_followups (source_id,section,position) ON DELETE RESTRICT,
  UNIQUE (source_id,section,position,revision)
);
