-- Per-company item review marker; planning metadata only.
ALTER TABLE items ADD COLUMN IF NOT EXISTS reviewed boolean NOT NULL DEFAULT false;
