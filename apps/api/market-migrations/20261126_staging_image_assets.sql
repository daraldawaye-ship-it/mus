CREATE TABLE IF NOT EXISTS market_staging_image_assets (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  webp bytea NOT NULL CHECK (octet_length(webp) BETWEEN 30 AND 200000),
  uploaded_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
