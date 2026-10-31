-- Company-wide temporary item checkmarks: shared across devices and authorized users.
-- Independent from item revisions/prices/stock and unaffected by invoice posting.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS temporary_selected boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS items_temporary_selected_company_idx
  ON items (company_id, id) WHERE temporary_selected = true;
