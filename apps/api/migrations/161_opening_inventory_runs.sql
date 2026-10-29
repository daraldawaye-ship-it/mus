-- Stock opening reconciliation batches; source and checkpoints stay out of Git.
CREATE TABLE IF NOT EXISTS opening_inventory_runs (
  id uuid PRIMARY KEY,
  company_id integer NOT NULL,
  location_id integer NOT NULL,
  equity_account_id integer NOT NULL,
  source_file_id text NOT NULL,
  source_sha256 text NOT NULL,
  source_items jsonb NOT NULL,
  source_count integer NOT NULL,
  document_date date NOT NULL,
  cursor integer NOT NULL DEFAULT 0,
  changed_count integer NOT NULL DEFAULT 0,
  unchanged_count integer NOT NULL DEFAULT 0,
  rounded_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','processing','completed')),
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(company_id,location_id,source_sha256),
  CHECK (cursor >= 0 AND cursor <= source_count)
);
CREATE INDEX IF NOT EXISTS opening_inventory_runs_company_idx
  ON opening_inventory_runs(company_id, created_at DESC);
