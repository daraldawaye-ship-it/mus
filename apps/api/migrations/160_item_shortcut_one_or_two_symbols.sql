-- Permit one or two visible shortcut characters, including digits and symbols.
-- Keep the company-wide case-insensitive unique index from migration 159.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_shortcut_exactly_two;
ALTER TABLE items ADD CONSTRAINT items_shortcut_one_or_two CHECK (
  shortcut = '' OR (
    char_length(shortcut) BETWEEN 1 AND 2
    AND shortcut !~ '[[:space:][:cntrl:]]'
  )
);
