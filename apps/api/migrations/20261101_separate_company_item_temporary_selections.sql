-- Temporary checklist is deliberately independent of the item master row:
-- items_identity requires revision+1 on any UPDATE to items. Selection must
-- not cause item-card revision conflicts or run item master triggers.
CREATE TABLE IF NOT EXISTS company_item_temporary_selections (
  company_id integer NOT NULL,
  item_id integer NOT NULL,
  selected_by integer REFERENCES users(id),
  selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, item_id),
  CONSTRAINT temporary_selection_item_company_fkey FOREIGN KEY (company_id, item_id)
    REFERENCES items(company_id, id) ON DELETE RESTRICT
);

-- Preserve every checked item from the initial, item-column implementation.
INSERT INTO company_item_temporary_selections(company_id, item_id)
SELECT company_id, id FROM items WHERE temporary_selected = true
ON CONFLICT (company_id, item_id) DO NOTHING;

-- Keep the legacy items.temporary_selected column temporarily for safe
-- rolling deployments: an old server process may still be serving reads while
-- this migration runs. All new reads and writes use only the separate table.
-- The legacy column is deprecated and is not a selection source of truth.
