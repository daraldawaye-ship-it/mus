-- Raw historical vouchers: phase 1 intake only, never changes journals or balances.
CREATE TABLE IF NOT EXISTS legacy_voucher_raw_import (
  company_id integer NOT NULL REFERENCES companies(id),
  source_system text NOT NULL,
  source_id text NOT NULL,
  source_row_number integer NOT NULL,
  source_payload jsonb NOT NULL,
  payload_sha256 text NOT NULL,
  posting_date date,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, source_system, source_id),
  UNIQUE (company_id, source_system, source_row_number)
);
CREATE INDEX IF NOT EXISTS legacy_voucher_raw_import_date_idx
  ON legacy_voucher_raw_import(company_id, posting_date);
