-- Append-only, scoped reconciliation of the 126 wrongly signed sales in the
-- 127-invoice import batch (company 2, 2026-10-30 UTC).
-- Original posted invoice/journal/movement rows remain immutable.
CREATE TABLE legacy_sales_sign_repairs (
  company_id integer NOT NULL,
  invoice_id integer NOT NULL,
  source_id varchar(200) NOT NULL,
  line_snapshots jsonb NOT NULL,
  previous_total numeric(28,6) NOT NULL,
  corrected_total numeric(28,6) NOT NULL,
  inventory_value_delta numeric(28,6) NOT NULL,
  stock_operation_id integer NOT NULL,
  revenue_document_id integer,
  cost_document_id integer,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id,invoice_id),
  UNIQUE (company_id,source_id),
  CHECK (company_id = 2),
  CHECK (jsonb_typeof(line_snapshots)='array')
);
CREATE INDEX legacy_sales_sign_repairs_source_idx ON legacy_sales_sign_repairs (company_id,source_id);
