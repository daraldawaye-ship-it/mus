ALTER TABLE items ADD COLUMN IF NOT EXISTS administrative_notes text NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS administrative_notes text NOT NULL DEFAULT '';
