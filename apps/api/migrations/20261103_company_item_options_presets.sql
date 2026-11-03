-- Reusable named item-list filters belong to the COMPANY, not the device/user.
-- No invoice, inventory or other business ledger data is changed.
CREATE TABLE IF NOT EXISTS company_item_options_presets (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  filters JSONB NOT NULL CHECK (jsonb_typeof(filters) = 'object'),
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS company_item_options_presets_name_uq
  ON company_item_options_presets(company_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS company_item_options_presets_list_idx
  ON company_item_options_presets(company_id, id);
