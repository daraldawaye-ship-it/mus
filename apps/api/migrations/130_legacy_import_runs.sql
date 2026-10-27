-- Owner-authorized bulk imports keep derived calculations deferred until a
-- durable run finishes. Other company operations cannot see partial caches.
CREATE TABLE legacy_import_runs (
  company_id integer NOT NULL REFERENCES companies(id),
  idempotency_key uuid NOT NULL,
  source_system varchar(100) NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  request_payload jsonb NOT NULL,
  round_unit_prices boolean NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','rebuilding','paused','failed','completed')),
  phase text NOT NULL DEFAULT 'importing',
  initial_pending integer NOT NULL CHECK(initial_pending>=0),
  imported integer NOT NULL DEFAULT 0 CHECK(imported>=0),
  existing integer NOT NULL DEFAULT 0 CHECK(existing>=0),
  failed_documents integer NOT NULL DEFAULT 0 CHECK(failed_documents>=0),
  rounded integer NOT NULL DEFAULT 0 CHECK(rounded>=0),
  last_posting_date date,
  last_source_id text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY(company_id,idempotency_key)
);
CREATE UNIQUE INDEX legacy_import_one_unfinished_run
  ON legacy_import_runs(company_id) WHERE status<>'completed';
CREATE TABLE legacy_import_dirty_items (
  company_id integer NOT NULL REFERENCES companies(id),
  item_id integer NOT NULL,
  PRIMARY KEY(company_id,item_id),
  FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id)
);
CREATE FUNCTION legacy_import_is_deferred(p_company integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM legacy_import_runs
    WHERE company_id=p_company AND status IN ('running','rebuilding')
      AND idempotency_key::text=current_setting('alraesy.legacy_import_run',true))
$$;
CREATE INDEX legacy_import_pending_invoices
  ON legacy_import_staging(company_id,source_system,posting_date,source_id)
  WHERE status='pending' AND source_kind='invoice';
