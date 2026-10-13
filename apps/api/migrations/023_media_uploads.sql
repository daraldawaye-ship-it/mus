-- Durable full-sized and small raster renditions; access is checked on every read.
CREATE TABLE media_assets (
 id uuid PRIMARY KEY,
 purpose text NOT NULL CHECK(purpose IN ('avatar','item')),
 company_id integer REFERENCES companies(id),
 uploaded_by integer NOT NULL REFERENCES users(id),
 original_mime text NOT NULL CHECK(original_mime IN ('image/webp','image/jpeg','image/png')),
 thumbnail_mime text NOT NULL CHECK(thumbnail_mime IN ('image/webp','image/jpeg','image/png')),
 original_bytes bytea NOT NULL CHECK(octet_length(original_bytes) BETWEEN 1 AND 2000000),
 thumbnail_bytes bytea NOT NULL CHECK(octet_length(thumbnail_bytes) BETWEEN 1 AND 150000),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((purpose='avatar' AND company_id IS NULL) OR (purpose='item' AND company_id IS NOT NULL))
);
CREATE INDEX media_assets_company ON media_assets(company_id,id) WHERE company_id IS NOT NULL;
ALTER TABLE items ADD COLUMN image_id uuid REFERENCES media_assets(id);
