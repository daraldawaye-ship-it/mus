-- Presentation preferences only. No grants or report data are touched.
CREATE TABLE company_table_column_defaults (
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  table_key text NOT NULL CHECK (table_key IN ('item-options-list', 'journal-lines')),
  revision integer NOT NULL CHECK (revision > 0),
  columns_json jsonb NOT NULL CHECK (
    jsonb_typeof(columns_json) = 'array' AND jsonb_array_length(columns_json) <= 64
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (company_id, table_key)
);
