-- Owner-only historical import staging: preserve raw source documents before posting.
CREATE TABLE IF NOT EXISTS legacy_import_staging (
  company_id integer NOT NULL REFERENCES companies(id),
  source_system varchar(100) NOT NULL,
  source_kind varchar(20) NOT NULL CHECK (source_kind IN ('invoice','voucher')),
  source_id varchar(100) NOT NULL,
  posting_date date NOT NULL,
  source_document jsonb NOT NULL,
  request_hash varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  error_message text,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,source_system,source_kind,source_id)
);
CREATE INDEX IF NOT EXISTS legacy_import_staging_queue
  ON legacy_import_staging(company_id,status,posting_date,source_id);
