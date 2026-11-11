-- Temporary working data for agents' medicine/product files.
-- Persistent staging (not PostgreSQL session TEMP); all user-provided fields optional.
-- Source columns preserve original values until reviewed and applied to market cards.
CREATE TABLE IF NOT EXISTS market_agent_catalog_staging (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent text,
  department text,
  manufacturer text,
  sort_order text,
  product_name_ar text,
  product_name_en text,
  composition text,
  usage text,
  dosage_form text,
  package text,
  price text,
  bonus text,
  notes text,
  agent_phone text,
  address text,
  source_file text,
  source_sheet text,
  source_row text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_agent_catalog_staging_agent_idx
  ON market_agent_catalog_staging (agent);
CREATE INDEX IF NOT EXISTS market_agent_catalog_staging_source_idx
  ON market_agent_catalog_staging (source_file, source_sheet);
COMMENT ON TABLE market_agent_catalog_staging IS
  'Temporary staging of agent medicine catalogs; all source fields optional. No automatic changes to live market cards.';
