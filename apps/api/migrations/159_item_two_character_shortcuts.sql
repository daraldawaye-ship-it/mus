-- A company-wide, stable two-character exact invoice-entry shortcut.
-- Empty means not assigned; archive state does not release an assigned shortcut.
ALTER TABLE items ADD COLUMN IF NOT EXISTS shortcut text NOT NULL DEFAULT ''
  CONSTRAINT items_shortcut_exactly_two CHECK (
    shortcut = '' OR (char_length(shortcut) = 2 AND shortcut !~ '[[:space:]]')
  );
CREATE UNIQUE INDEX IF NOT EXISTS items_company_shortcut_unique
  ON items (company_id, lower(shortcut)) WHERE shortcut <> '';
