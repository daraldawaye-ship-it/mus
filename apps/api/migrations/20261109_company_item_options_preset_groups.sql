-- Named ordered combinations of existing company-wide item-option presets.
-- A group is reusable and shared. Actual purchase drafts remain local to the
-- invoking device and are only replaced after a fully successful read-only run.
CREATE TABLE IF NOT EXISTS company_item_options_preset_groups (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  preset_ids BIGINT[] NOT NULL CHECK (cardinality(preset_ids) BETWEEN 1 AND 20),
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS company_item_options_preset_groups_name_uq
  ON company_item_options_preset_groups(company_id,lower(btrim(name)));
CREATE INDEX IF NOT EXISTS company_item_options_preset_groups_list_idx
  ON company_item_options_preset_groups(company_id,id);
