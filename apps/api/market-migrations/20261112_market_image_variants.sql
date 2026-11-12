-- Derived images only. Existing source images and card revisions are unchanged.
CREATE TABLE IF NOT EXISTS market_image_variants (
  source_key text PRIMARY KEY CHECK (source_key ~ '^[a-f0-9]{64}$'),
  source_url text NOT NULL UNIQUE CHECK (length(source_url) <= 2048),
  image_id uuid REFERENCES market_image_uploads(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ready','error')),
  icon_bytes bytea CHECK (octet_length(icon_bytes) <= 16384),
  preview_bytes bytea CHECK (octet_length(preview_bytes) <= 65536),
  icon_width integer CHECK (icon_width BETWEEN 1 AND 64),
  icon_height integer CHECK (icon_height BETWEEN 1 AND 64),
  preview_width integer CHECK (preview_width BETWEEN 1 AND 240),
  preview_height integer CHECK (preview_height BETWEEN 1 AND 240),
  source_bytes integer CHECK (source_bytes >= 0),
  error_code text NOT NULL DEFAULT '' CHECK (length(error_code) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ready' OR
    (icon_bytes IS NOT NULL AND preview_bytes IS NOT NULL AND
     icon_width IS NOT NULL AND icon_height IS NOT NULL AND
     preview_width IS NOT NULL AND preview_height IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS market_image_variants_upload_idx ON market_image_variants(image_id)
  WHERE image_id IS NOT NULL;
